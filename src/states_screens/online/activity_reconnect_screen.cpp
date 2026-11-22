//  SuperTuxKart - a fun racing game with go-kart
//  Copyright (C) 2026 SuperTuxKart-Team
//
//  This program is free software; you can redistribute it and/or
//  modify it under the terms of the GNU General Public License
//  as published by the Free Software Foundation; either version 3
//  of the License, or (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//  GNU General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with this program; if not, write to the Free Software
//  Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

#include "states_screens/online/activity_reconnect_screen.hpp"

#include "config/player_manager.hpp"
#include "guiengine/modaldialog.hpp"
#include "guiengine/screen_keyboard.hpp"
#include "guiengine/widgets/button_widget.hpp"
#include "guiengine/widgets/label_widget.hpp"
#include "input/device_manager.hpp"
#include "input/input_manager.hpp"
#include "modes/world.hpp"
#include "network/network_config.hpp"
#include "network/server.hpp"
#include "network/socket_address.hpp"
#include "network/stk_host.hpp"
#include "online/wasm_time_trial_bridge.hpp"
#include "race/race_manager.hpp"
#include "states_screens/offline_kart_selection.hpp"
#include "states_screens/online/networking_lobby.hpp"
#include "states_screens/state_manager.hpp"
#include "utils/log.hpp"
#include "utils/string_utils.hpp"
#include "utils/time.hpp"
#include "utils/translation.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <sstream>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace GUIEngine;

namespace
{

const int MAX_AUTO_RECONNECT_ATTEMPTS = 5;
const uint64_t RECOVERY_WINDOW_MS = 10000;
const size_t MAX_RECOVERIES_IN_WINDOW = 3;

std::string escapeJson(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s)
    {
        if (c == '"' || c == '\\')
        {
            out.push_back('\\');
            out.push_back(c);
        }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out.push_back(c);
    }
    return out;
}

std::string toLowerAscii(std::string s)
{
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return (char)std::tolower(c); });
    return s;
}

std::vector<uint64_t>& getRecoveryTimestamps()
{
    static std::vector<uint64_t> timestamps;
    return timestamps;
}

}   // namespace

// ----------------------------------------------------------------------------
ActivityReconnectScreen::ActivityReconnectScreen()
    : Screen("online/activity_reconnect.stkgui")
{
    m_title = NULL;
    m_reason_label = NULL;
    m_status_label = NULL;
    m_reconnect_button = NULL;
    m_reload_button = NULL;

    m_reason = _("Lost connection to the Activity server.");
    m_auto_reconnect = true;
    m_fatal_reload_only = false;
    m_reconnect_in_flight = false;
    m_auto_attempts = 0;
    m_next_req_id = 1;
    m_active_req_id = 0;
    m_next_retry_time_ms = 0;
}   // ActivityReconnectScreen

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::configure(const irr::core::stringw& reason,
                                        bool auto_reconnect,
                                        bool fatal_reload_only)
{
    m_reason = reason.empty()
        ? _("Lost connection to the Activity server.")
        : reason;
    m_auto_reconnect = auto_reconnect && !fatal_reload_only;
    m_fatal_reload_only = fatal_reload_only;
    m_reconnect_in_flight = false;
    m_auto_attempts = 0;
    m_next_retry_time_ms = 0;
    m_status_text = L"";
}   // configure

// ----------------------------------------------------------------------------
bool ActivityReconnectScreen::shouldAutoReconnect(const irr::core::stringw& error_msg)
{
    std::string lower = toLowerAscii(StringUtils::wideToUtf8(error_msg));
    if (lower.find("kicked") != std::string::npos ||
        lower.find("banned") != std::string::npos ||
        lower.find("incompatible") != std::string::npos ||
        lower.find("server is full") != std::string::npos ||
        lower.find("invalid player") != std::string::npos ||
        lower.find("wrong password") != std::string::npos)
    {
        return false;
    }
    return true;
}   // shouldAutoReconnect

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::logTelemetryError(const std::string& tag,
                                                const std::string& message)
{
    Log::error(tag.c_str(), "%s", message.c_str());
#ifdef __EMSCRIPTEN__
    std::string full = "[" + tag + "] " + message;
    EM_ASM({
        try {
            var msg = UTF8ToString($0);
            if (globalThis.telemetry && typeof globalThis.telemetry.record === "function") {
                globalThis.telemetry.record({level: "error", source: "error", message: msg});
                if (typeof globalThis.telemetry.flush === "function") {
                    globalThis.telemetry.flush();
                }
            }
        } catch (_) {}
    }, full.c_str());
#endif
}   // logTelemetryError

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::logDisconnectTelemetry(const irr::core::stringw& reason,
                                                     bool in_world,
                                                     bool auto_reconnect)
{
    std::string reason_utf8 = StringUtils::wideToUtf8(reason);
    std::string ws_state = "null";
#ifdef __EMSCRIPTEN__
    char* raw = (char*)EM_ASM_PTR({
        try {
            if (!globalThis.stkLanBridge || typeof globalThis.stkLanBridge.getState !== "function")
                return 0;
            var s = JSON.stringify(globalThis.stkLanBridge.getState());
            var bytes = new TextEncoder().encode(s);
            var ptr = _malloc(bytes.length + 1);
            if (!ptr) return 0;
            HEAPU8.set(bytes, ptr);
            HEAPU8[ptr + bytes.length] = 0;
            return ptr;
        } catch (_) {
            return 0;
        }
    });
    if (raw)
    {
        ws_state = std::string(raw);
        std::free(raw);
    }
#endif
    std::ostringstream oss;
    oss << "{"
        << "\"event\":\"server_disconnected\","
        << "\"reason\":\"" << escapeJson(reason_utf8) << "\","
        << "\"in_world\":" << (in_world ? "true" : "false") << ","
        << "\"auto_reconnect\":" << (auto_reconnect ? "true" : "false") << ","
        << "\"ws\":" << ws_state
        << "}";
    logTelemetryError("disconnect", oss.str());
}   // logDisconnectTelemetry

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::recoverFromForbiddenScreen(const std::string& forbidden_screen,
                                                         const std::string& stack_snapshot)
{
    uint64_t now = StkTime::getMonoTimeMs();
    auto& ts = getRecoveryTimestamps();
    ts.erase(std::remove_if(ts.begin(), ts.end(),
                            [now](uint64_t t) { return now - t > RECOVERY_WINDOW_MS; }),
             ts.end());
    ts.push_back(now);

    bool is_tt = WasmTimeTrialBridge::get()->isChallengeMode();
    bool has_host = STKHost::existHost();
    bool in_world = (World::getWorld() != NULL);
    std::string last_err;
    if (has_host)
        last_err = StringUtils::wideToUtf8(STKHost::get()->getErrorMessage());

    std::ostringstream oss;
    oss << "{"
        << "\"forbidden_screen\":\"" << escapeJson(forbidden_screen) << "\","
        << "\"stack\":\"" << escapeJson(stack_snapshot) << "\","
        << "\"mode\":\"" << (is_tt ? "time_trial" : "multiplayer") << "\","
        << "\"in_world\":" << (in_world ? "true" : "false") << ","
        << "\"exist_host\":" << (has_host ? "true" : "false") << ","
        << "\"last_host_error\":\"" << escapeJson(last_err) << "\","
        << "\"recoveries_in_10s\":" << ts.size()
        << "}";
    logTelemetryError("nav-guard", oss.str());

    GUIEngine::ModalDialog::dismiss();
    GUIEngine::ScreenKeyboard::dismiss();

    if (World::getWorld())
    {
        RaceManager::get()->clearNetworkGrandPrixResult();
        RaceManager::get()->exitRace();
        RaceManager::get()->setAIKartOverride("");
    }

    if (ts.size() > MAX_RECOVERIES_IN_WINDOW)
    {
        ActivityReconnectScreen::getInstance()->configure(
            _("An unexpected navigation error occurred. Please reload the Activity."),
            /*auto_reconnect*/ false,
            /*fatal_reload_only*/ true);
        StateManager::get()->resetAndGoToScreen(ActivityReconnectScreen::getInstance());
        return;
    }

    if (is_tt)
    {
        NetworkConfig::get()->unsetNetworking();
        KartSelectionScreen* s = OfflineKartSelectionScreen::getInstance();
        s->setMultiplayer(false);
        s->setFromOverworld(false);
        StateManager::get()->resetAndGoToScreen(s);
        return;
    }

    if (has_host && !STKHost::get()->requestedShutdown())
    {
        StateManager::get()->resetAndGoToScreen(NetworkingLobby::getInstance());
        return;
    }

    if (has_host)
    {
        STKHost::get()->shutdown();
    }
    NetworkConfig::get()->unsetNetworking();

    ActivityReconnectScreen::getInstance()->configure(
        _("Reconnecting to your Discord Activity lobby..."),
        /*auto_reconnect*/ true,
        /*fatal_reload_only*/ false);
    StateManager::get()->resetAndGoToScreen(ActivityReconnectScreen::getInstance());
}   // recoverFromForbiddenScreen

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::loadedFromFile()
{
    m_title = getWidget<LabelWidget>("title");
    m_reason_label = getWidget<LabelWidget>("reason");
    m_status_label = getWidget<LabelWidget>("status");
    m_reconnect_button = getWidget<ButtonWidget>("reconnect");
    m_reload_button = getWidget<ButtonWidget>("reload");
}   // loadedFromFile

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::init()
{
    Screen::init();

    if (m_title)
    {
        m_title->setText(
            m_fatal_reload_only ? _("Activity Error") : _("Connection Lost"),
            true);
    }
    if (m_reason_label)
    {
        m_reason_label->setText(m_reason, false);
    }
    if (m_reconnect_button)
    {
        m_reconnect_button->setVisible(!m_fatal_reload_only);
        m_reconnect_button->setActive(!m_fatal_reload_only);
    }
    if (m_reload_button)
    {
        m_reload_button->setVisible(true);
        m_reload_button->setActive(true);
    }

    if (m_fatal_reload_only)
    {
        m_status_text = _("Press Reload Activity to restart.");
        updateStatusLabel();
        if (m_reload_button)
            m_reload_button->setFocusForPlayer(PLAYER_ID_GAME_MASTER);
    }
    else if (m_auto_reconnect)
    {
        // Brief initial delay (2s) so the user can read the disconnect reason
        // and the gateway/container has a moment to settle before reconnecting.
        m_next_retry_time_ms = StkTime::getMonoTimeMs() + 2000;
        updateStatusLabel();
        if (m_reconnect_button)
            m_reconnect_button->setFocusForPlayer(PLAYER_ID_GAME_MASTER);
    }
    else
    {
        m_status_text = _("Press Reconnect Now to try joining again.");
        updateStatusLabel();
        if (m_reconnect_button)
            m_reconnect_button->setFocusForPlayer(PLAYER_ID_GAME_MASTER);
    }
}   // init

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::updateStatusLabel()
{
    if (!m_status_label)
        return;

    if (m_reconnect_in_flight || m_fatal_reload_only || !m_auto_reconnect)
    {
        m_status_label->setText(m_status_text, false);
        return;
    }

    uint64_t now = StkTime::getMonoTimeMs();
    if (m_next_retry_time_ms > now)
    {
        int secs = (int)((m_next_retry_time_ms - now + 999) / 1000);
        irr::core::stringw msg = _P("Reconnecting automatically in %d second...",
                                    "Reconnecting automatically in %d seconds...",
                                    secs);
        m_status_label->setText(msg, false);
    }
    else
    {
        m_status_label->setText(m_status_text, false);
    }
}   // updateStatusLabel

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::startReconnectAttempt()
{
    if (m_reconnect_in_flight || m_fatal_reload_only)
        return;

    m_reconnect_in_flight = true;
    m_active_req_id = m_next_req_id++;
    m_status_text = _("Connecting to multiplayer gateway...");
    if (m_reconnect_button)
        m_reconnect_button->setActive(false);
    updateStatusLabel();

#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (typeof globalThis.stkReconnectLanBridge === "function") {
            globalThis.stkReconnectLanBridge($0);
        } else if (typeof Module !== "undefined" && typeof Module._stk_reconnect_on_done === "function") {
            Module._stk_reconnect_on_done($0, 0, 0);
        }
    }, m_active_req_id);
#else
    onJsReconnectDone(m_active_req_id, false, "Reconnect is only supported in Discord Activity WASM.");
#endif
}   // startReconnectAttempt

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::onJsReconnectStatus(uint32_t req_id,
                                                  const std::string& status)
{
    if (req_id != m_active_req_id)
        return;

    if (status == "connecting")
        m_status_text = _("Connecting to multiplayer gateway...");
    else if (status == "authenticating")
        m_status_text = _("Authenticating with Discord...");
    else if (status == "starting_server")
        m_status_text = _("Starting game server for this Activity...");
    else if (status == "waiting_for_server")
        m_status_text = _("Waiting for Activity game server to start...");
    else if (status == "ready")
        m_status_text = _("Game server ready! Rejoining lobby...");
    else
        m_status_text = StringUtils::utf8ToWide("Connecting (" + status + ")...");

    updateStatusLabel();
}   // onJsReconnectStatus

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::onJsReconnectDone(uint32_t req_id, bool ok,
                                                const std::string& error_msg)
{
    if (req_id != m_active_req_id)
        return;

    m_reconnect_in_flight = false;
    if (m_reconnect_button && !m_fatal_reload_only)
        m_reconnect_button->setActive(true);

    if (ok)
    {
        completeLobbyRejoin();
        return;
    }

    m_auto_attempts++;
    if (!error_msg.empty())
        m_reason = StringUtils::utf8ToWide(error_msg);
    if (m_reason_label)
        m_reason_label->setText(m_reason, false);

    if (m_auto_reconnect && m_auto_attempts < MAX_AUTO_RECONNECT_ATTEMPTS)
    {
        // Exponential backoff: 2s, 4s, 8s, 10s
        uint64_t delay_ms = std::min<uint64_t>(10000, 2000ULL << std::min(m_auto_attempts - 1, 3));
        m_next_retry_time_ms = StkTime::getMonoTimeMs() + delay_ms;
    }
    else
    {
        m_auto_reconnect = false;
        m_next_retry_time_ms = 0;
        m_status_text = _("Automatic reconnect paused. Press Reconnect Now or Reload Activity.");
    }
    updateStatusLabel();
}   // onJsReconnectDone

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::completeLobbyRejoin()
{
    if (STKHost::existHost())
        STKHost::get()->shutdown();

    NetworkConfig::get()->unsetNetworking();
    NetworkConfig::get()->setIsLAN();
    NetworkConfig::get()->setIsServer(false);
    NetworkConfig::get()->cleanNetworkPlayers();
    NetworkConfig::get()->addNetworkPlayer(
        input_manager->getDeviceManager()->getLatestUsedDevice(),
        PlayerManager::getCurrentPlayer(), HANDICAP_NONE);
    NetworkConfig::get()->doneAddingNetworkPlayers();

    SocketAddress server_addr("10.0.0.1:2759");
    auto server = std::make_shared<UserDefinedServer>(
        irr::core::stringw(L"Discord Activity Lobby"), server_addr, false);

    NetworkingLobby::getInstance()->setJoinedServer(server);
    STKHost::create();
    StateManager::get()->resetAndGoToScreen(NetworkingLobby::getInstance());
}   // completeLobbyRejoin

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::onUpdate(float delta)
{
    if (m_fatal_reload_only || m_reconnect_in_flight)
        return;

    if (m_auto_reconnect && m_next_retry_time_ms > 0)
    {
        if (StkTime::getMonoTimeMs() >= m_next_retry_time_ms)
        {
            startReconnectAttempt();
        }
        else
        {
            updateStatusLabel();
        }
    }
}   // onUpdate

// ----------------------------------------------------------------------------
void ActivityReconnectScreen::eventCallback(Widget* widget,
                                            const std::string& name,
                                            const int playerID)
{
    if (name == "reconnect")
    {
        m_auto_attempts = 0;
        m_auto_reconnect = true;
        startReconnectAttempt();
    }
    else if (name == "reload")
    {
        logTelemetryError("activity-reload", "User clicked Reload Activity button.");
#ifdef __EMSCRIPTEN__
        EM_ASM({
            window.location.reload();
        });
#endif
    }
}   // eventCallback

// ----------------------------------------------------------------------------
bool ActivityReconnectScreen::onEscapePressed()
{
    // Never allow escaping out of the reconnect screen to the main menu.
    return false;
}   // onEscapePressed

// ----------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
extern "C"
{

EMSCRIPTEN_KEEPALIVE void* stk_reconnect_alloc(size_t size)
{
    return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE void stk_reconnect_free(void* ptr)
{
    std::free(ptr);
}

EMSCRIPTEN_KEEPALIVE void stk_reconnect_on_status(uint32_t req_id,
                                                  const char* status_utf8)
{
    ActivityReconnectScreen::getInstance()->onJsReconnectStatus(
        req_id, status_utf8 ? std::string(status_utf8) : std::string());
}

EMSCRIPTEN_KEEPALIVE void stk_reconnect_on_done(uint32_t req_id, int ok,
                                                const char* err_utf8)
{
    ActivityReconnectScreen::getInstance()->onJsReconnectDone(
        req_id, ok != 0, err_utf8 ? std::string(err_utf8) : std::string());
}

}   // extern "C"
#endif
