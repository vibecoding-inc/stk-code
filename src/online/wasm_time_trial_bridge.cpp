//
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

#include "online/wasm_time_trial_bridge.hpp"

#include "config/player_manager.hpp"
#include "guiengine/message_queue.hpp"
#include "race/race_manager.hpp"
#include "replay/replay_play.hpp"
#include "states_screens/state_manager.hpp"
#include "utils/file_utils.hpp"
#include "utils/log.hpp"
#include "utils/string_utils.hpp"
#include "utils/translation.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace
{

// Minimal JSON field extractors for our flat Worker/JS bridge payloads.
// Avoids pulling in an external JSON library or inflating supertuxkart.wasm.
bool extractJsonString(const std::string& json, const std::string& key, std::string& out)
{
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return false;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t' || json[pos] == '\n'))
        pos++;
    if (pos >= json.size() || json[pos] != '"') return false;
    pos++;
    std::string result;
    while (pos < json.size())
    {
        char c = json[pos++];
        if (c == '\\' && pos < json.size())
        {
            char esc = json[pos++];
            if (esc == '"' || esc == '\\' || esc == '/') result.push_back(esc);
            else if (esc == 'n') result.push_back('\n');
            else if (esc == 't') result.push_back('\t');
            else result.push_back(esc);
        }
        else if (c == '"')
        {
            out = result;
            return true;
        }
        else
        {
            result.push_back(c);
        }
    }
    return false;
}

bool extractJsonInt(const std::string& json, const std::string& key, int& out)
{
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return false;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t'))
        pos++;
    char* end = nullptr;
    long val = std::strtol(json.c_str() + pos, &end, 10);
    if (end == json.c_str() + pos) return false;
    out = (int)val;
    return true;
}

bool extractJsonBool(const std::string& json, const std::string& key, bool& out)
{
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return false;
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t'))
        pos++;
    if (json.compare(pos, 4, "true") == 0)
    {
        out = true;
        return true;
    }
    if (json.compare(pos, 5, "false") == 0)
    {
        out = false;
        return true;
    }
    return false;
}

bool extractJsonStringArray(const std::string& json, const std::string& key,
                            std::vector<std::string>& out)
{
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return false;
    pos = json.find('[', pos + needle.size());
    if (pos == std::string::npos) return false;
    pos++;
    out.clear();
    while (pos < json.size())
    {
        while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t' ||
                                     json[pos] == '\n' || json[pos] == ','))
            pos++;
        if (pos >= json.size() || json[pos] == ']')
            return true;
        if (json[pos] != '"')
            return false;
        pos++;
        std::string item;
        while (pos < json.size())
        {
            char c = json[pos++];
            if (c == '\\' && pos < json.size())
            {
                item.push_back(json[pos++]);
            }
            else if (c == '"')
            {
                out.push_back(item);
                break;
            }
            else
            {
                item.push_back(c);
            }
        }
    }
    return false;
}

std::string escapeJsonString(const std::string& s)
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

}   // namespace

// ----------------------------------------------------------------------------
WasmTimeTrialBridge::WasmTimeTrialBridge()
    : m_challenge_mode(false),
      m_difficulty(2),
      m_laps(3),
      m_reverse(false),
      m_next_req_id(1),
      m_pending_refresh_req_id(0),
      m_pending_submit_req_id(0),
      m_refresh_in_flight(false)
{
}   // WasmTimeTrialBridge

// ----------------------------------------------------------------------------
WasmTimeTrialBridge* WasmTimeTrialBridge::get()
{
    static WasmTimeTrialBridge instance;
    return &instance;
}   // get

// ----------------------------------------------------------------------------
void WasmTimeTrialBridge::parsePreparedJson(const std::string& json)
{
    if (json.empty()) return;

    std::string cid, track;
    if (!extractJsonString(json, "challenge_id", cid) || cid.empty())
        return;
    if (!extractJsonString(json, "track", track) || track.empty())
        return;

    int diff = 2;
    int laps = 3;
    bool rev = false;
    extractJsonInt(json, "difficulty", diff);
    extractJsonInt(json, "laps", laps);
    extractJsonBool(json, "reverse", rev);

    std::vector<std::string> ghosts;
    extractJsonStringArray(json, "ghost_files", ghosts);

    m_challenge_id = cid;
    m_track = track;
    m_difficulty = std::max(0, std::min(3, diff));
    m_laps = std::max(1, std::min(20, laps));
    m_reverse = rev;
    m_ghost_files = std::move(ghosts);
    m_challenge_mode = true;

    Log::info("WasmTimeTrialBridge",
              "Loaded Time Trial challenge '%s' (track=%s, laps=%d, diff=%d, reverse=%d, ghosts=%u).",
              m_challenge_id.c_str(), m_track.c_str(), m_laps, m_difficulty,
              (int)m_reverse, (unsigned)m_ghost_files.size());
}   // parsePreparedJson

// ----------------------------------------------------------------------------
void WasmTimeTrialBridge::initFromJS()
{
#ifdef __EMSCRIPTEN__
    char* raw = (char*)EM_ASM_PTR({
        if (!globalThis.stkTimeTrials ||
            typeof globalThis.stkTimeTrials.getPreparedChallengeJson !== "function")
            return 0;
        var s = globalThis.stkTimeTrials.getPreparedChallengeJson();
        if (!s) return 0;
        var bytes = new TextEncoder().encode(s);
        var ptr = _malloc(bytes.length + 1);
        if (!ptr) return 0;
        HEAPU8.set(bytes, ptr);
        HEAPU8[ptr + bytes.length] = 0;
        return ptr;
    });
    if (raw)
    {
        std::string json(raw);
        std::free(raw);
        parsePreparedJson(json);
    }
#endif
}   // initFromJS

// ----------------------------------------------------------------------------
void WasmTimeTrialBridge::startChallengeRace()
{
#ifndef SERVER_ONLY
    if (!m_challenge_mode) return;

    if (!ReplayPlay::get())
        ReplayPlay::create();

    ReplayPlay* rp = ReplayPlay::get();
    rp->clearReplayFileList();

    std::vector<unsigned int> active_indices;
    for (const std::string& path : m_ghost_files)
    {
        if (rp->addReplayFile(path, /*custom_replay*/ true))
        {
            active_indices.push_back(rp->getNumReplayFile() - 1);
        }
    }
    rp->setActiveReplayFiles(active_indices);

    RaceManager::get()->setMajorMode(RaceManager::MAJOR_MODE_SINGLE);
    RaceManager::get()->setMinorMode(RaceManager::MINOR_MODE_TIME_TRIAL);
    RaceManager::get()->setDifficulty((RaceManager::Difficulty)m_difficulty);
    RaceManager::get()->setReverseTrack(m_reverse);
    RaceManager::get()->setRecordRace(true);
    RaceManager::get()->setWatchingReplay(false);
    RaceManager::get()->setRaceGhostKarts(!active_indices.empty());
    RaceManager::get()->setNumKarts(RaceManager::get()->getNumLocalPlayers());

    if (PlayerManager::getCurrentPlayer())
        PlayerManager::getCurrentPlayer()->setCurrentChallenge("");

    RaceManager::get()->startSingleRace(m_track, m_laps, false);
#endif
}   // startChallengeRace

// ----------------------------------------------------------------------------
void WasmTimeTrialBridge::submitCompletedRun(const std::string& replay_full_path,
                                             const std::string& kart_ident,
                                             float kart_color,
                                             float finish_time_sec,
                                             int replay_version)
{
#ifdef __EMSCRIPTEN__
    if (!m_challenge_mode || m_challenge_id.empty()) return;

    FILE* fd = FileUtils::fopenU8Path(replay_full_path, "rb");
    if (!fd)
    {
        Log::warn("WasmTimeTrialBridge", "Could not open replay '%s' for upload.",
                  replay_full_path.c_str());
        return;
    }

    std::fseek(fd, 0, SEEK_END);
    long fsize = std::ftell(fd);
    std::fseek(fd, 0, SEEK_SET);
    if (fsize <= 0 || fsize > 4 * 1024 * 1024)
    {
        std::fclose(fd);
        Log::warn("WasmTimeTrialBridge", "Replay '%s' size (%ld) out of bounds.",
                  replay_full_path.c_str(), fsize);
        return;
    }

    std::vector<uint8_t> bytes((size_t)fsize);
    size_t nread = std::fread(bytes.data(), 1, bytes.size(), fd);
    std::fclose(fd);
    if (nread == 0) return;

    int time_ms = (int)std::llround((double)finish_time_sec * 1000.0);
    if (time_ms <= 0) return;

    std::ostringstream meta;
    meta << "{"
         << "\"challenge_id\":\"" << escapeJsonString(m_challenge_id) << "\","
         << "\"kart\":\"" << escapeJsonString(kart_ident) << "\","
         << "\"kart_color\":" << kart_color << ","
         << "\"time_ms\":" << time_ms << ","
         << "\"replay_version\":" << replay_version
         << "}";
    std::string meta_str = meta.str();

    uint32_t req_id = m_next_req_id++;
    m_pending_submit_req_id = req_id;

    EM_ASM({
        if (globalThis.stkTimeTrials &&
            typeof globalThis.stkTimeTrials.requestSubmitRun === "function")
        {
            var meta = UTF8ToString($1);
            globalThis.stkTimeTrials.requestSubmitRun($0, meta, $2, $3);
        }
    }, req_id, meta_str.c_str(), bytes.data(), (int)nread);
#else
    (void)replay_full_path;
    (void)kart_ident;
    (void)kart_color;
    (void)finish_time_sec;
    (void)replay_version;
#endif
}   // submitCompletedRun

// ----------------------------------------------------------------------------
void WasmTimeTrialBridge::refreshGhostsAndRestart()
{
#ifndef SERVER_ONLY
    if (!m_challenge_mode) return;
    if (m_refresh_in_flight) return;

#ifdef __EMSCRIPTEN__
    m_refresh_in_flight = true;
    uint32_t req_id = m_next_req_id++;
    m_pending_refresh_req_id = req_id;

    MessageQueue::add(MessageQueue::MT_GENERIC, _("Loading latest ghosts..."));

    EM_ASM({
        if (globalThis.stkTimeTrials &&
            typeof globalThis.stkTimeTrials.requestRefreshGhosts === "function")
        {
            var cid = UTF8ToString($1);
            globalThis.stkTimeTrials.requestRefreshGhosts($0, cid);
        }
        else if (typeof _stk_tt_on_ghosts_ready === "function")
        {
            _stk_tt_on_ghosts_ready($0, 0, 0);
        }
    }, req_id, m_challenge_id.c_str());
#else
    StateManager::get()->popMenu();
    RaceManager::get()->exitRace();
    startChallengeRace();
#endif
#endif
}   // refreshGhostsAndRestart

// ----------------------------------------------------------------------------
void WasmTimeTrialBridge::onGhostsReady(uint32_t req_id, int http_status,
                                        const std::string& json)
{
#ifndef SERVER_ONLY
    if (req_id != m_pending_refresh_req_id) return;
    m_refresh_in_flight = false;

    if (http_status == 200 && !json.empty())
    {
        std::vector<std::string> ghosts;
        if (extractJsonStringArray(json, "ghost_files", ghosts))
        {
            m_ghost_files = std::move(ghosts);
        }
    }

    StateManager::get()->popMenu();
    RaceManager::get()->exitRace();
    startChallengeRace();
#else
    (void)req_id;
    (void)http_status;
    (void)json;
#endif
}   // onGhostsReady

// ----------------------------------------------------------------------------
void WasmTimeTrialBridge::onSubmitResult(uint32_t req_id, int http_status,
                                         const std::string& json)
{
#ifndef SERVER_ONLY
    if (req_id != m_pending_submit_req_id) return;

    if (http_status != 200 || json.empty())
    {
        MessageQueue::add(MessageQueue::MT_ERROR,
                          _("Could not upload Time Trial result."));
        return;
    }

    bool is_new_pb = false;
    bool is_new_first = false;
    int rank = 0;
    int total = 0;
    extractJsonBool(json, "is_new_pb", is_new_pb);
    extractJsonBool(json, "is_new_first", is_new_first);
    extractJsonInt(json, "rank", rank);
    extractJsonInt(json, "total_players", total);

    if (is_new_first)
    {
        MessageQueue::add(MessageQueue::MT_ACHIEVEMENT,
                          _("New 1st Place! (#1 of %d)", total));
    }
    else if (is_new_pb && rank > 0)
    {
        MessageQueue::add(MessageQueue::MT_ACHIEVEMENT,
                          _("New Personal Best! (#%d of %d)", rank, total));
    }
    else if (rank > 0)
    {
        MessageQueue::add(MessageQueue::MT_GENERIC,
                          _("Time Trial rank: #%d of %d", rank, total));
    }
#else
    (void)req_id;
    (void)http_status;
    (void)json;
#endif
}   // onSubmitResult

// ----------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
extern "C"
{

EMSCRIPTEN_KEEPALIVE void* stk_tt_alloc(size_t size)
{
    return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE void stk_tt_free(void* ptr)
{
    std::free(ptr);
}

EMSCRIPTEN_KEEPALIVE void stk_tt_on_ghosts_ready(uint32_t req_id, int http_status,
                                                 const char* json_utf8)
{
    WasmTimeTrialBridge::get()->onGhostsReady(
        req_id, http_status, json_utf8 ? std::string(json_utf8) : std::string());
}

EMSCRIPTEN_KEEPALIVE void stk_tt_on_submit_result(uint32_t req_id, int http_status,
                                                  const char* json_utf8)
{
    WasmTimeTrialBridge::get()->onSubmitResult(
        req_id, http_status, json_utf8 ? std::string(json_utf8) : std::string());
}

}   // extern "C"
#endif
