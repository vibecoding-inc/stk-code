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

#ifndef HEADER_ACTIVITY_RECONNECT_SCREEN_HPP
#define HEADER_ACTIVITY_RECONNECT_SCREEN_HPP

#include "guiengine/screen.hpp"

#include <cstdint>
#include <irrString.h>
#include <string>

namespace GUIEngine
{
    class ButtonWidget;
    class LabelWidget;
}

/**
 * Native Discord Activity reconnect / error screen.
 *
 * Shown whenever the multiplayer server connection drops or fails instead of
 * dumping the player back to the desktop Main Menu or LAN server browser.
 * Automatically re-establishes the WebSocket gateway (which spins up a fresh
 * gameserver container if needed) and rejoins NetworkingLobby with backoff.
 *
 * Also hosts the Discord Activity navigation guard and telemetry logger used
 * if any unexpected path ever lands on a forbidden desktop screen.
 */
class ActivityReconnectScreen : public GUIEngine::Screen,
                                public GUIEngine::ScreenSingleton<ActivityReconnectScreen>
{
    friend class GUIEngine::ScreenSingleton<ActivityReconnectScreen>;

private:
    GUIEngine::LabelWidget*  m_title;
    GUIEngine::LabelWidget*  m_reason_label;
    GUIEngine::LabelWidget*  m_status_label;
    GUIEngine::ButtonWidget* m_reconnect_button;
    GUIEngine::ButtonWidget* m_reload_button;

    irr::core::stringw m_reason;
    irr::core::stringw m_status_text;
    bool               m_auto_reconnect;
    bool               m_fatal_reload_only;
    bool               m_reconnect_in_flight;
    int                m_auto_attempts;
    uint32_t           m_next_req_id;
    uint32_t           m_active_req_id;
    uint64_t           m_next_retry_time_ms;

    ActivityReconnectScreen();

    void startReconnectAttempt();
    void updateStatusLabel();
    void completeLobbyRejoin();

public:
    /** Configure reason and behavior before pushing/resetting to this screen. */
    void configure(const irr::core::stringw& reason,
                   bool auto_reconnect = true,
                   bool fatal_reload_only = false);

    /** Heuristic for whether a disconnect error is transient and worth auto-retrying. */
    static bool shouldAutoReconnect(const irr::core::stringw& error_msg);

    /** Emits a Log::error and flushes an immediate telemetry error event in WASM. */
    static void logTelemetryError(const std::string& tag,
                                  const std::string& message);

    /** Logs a structured disconnect event (including JS lan-bridge socket state). */
    static void logDisconnectTelemetry(const irr::core::stringw& reason,
                                       bool in_world,
                                       bool auto_reconnect);

    /**
     * Records a forbidden-screen tripwire hit and returns true if recovery
     * should proceed (false if the loop breaker tripped and switched to
     * fatal reload-only mode).
     */
    static void recoverFromForbiddenScreen(const std::string& forbidden_screen,
                                           const std::string& stack_snapshot);

    /** Callbacks invoked from JS (script.js) during lan-bridge reconnect. */
    void onJsReconnectStatus(uint32_t req_id, const std::string& status);
    void onJsReconnectDone(uint32_t req_id, bool ok, const std::string& error_msg);

    /** \brief implement callback from parent class GUIEngine::Screen */
    virtual void loadedFromFile() OVERRIDE;

    /** \brief implement callback from parent class GUIEngine::Screen */
    virtual void init() OVERRIDE;

    /** \brief implement callback from parent class GUIEngine::Screen */
    virtual void onUpdate(float delta) OVERRIDE;

    /** \brief implement callback from parent class GUIEngine::Screen */
    virtual void eventCallback(GUIEngine::Widget* widget,
                               const std::string& name,
                               const int playerID) OVERRIDE;

    /** \brief implement callback from parent class GUIEngine::Screen */
    virtual bool onEscapePressed() OVERRIDE;
};

#endif
