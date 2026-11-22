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

#ifndef HEADER_WASM_TIME_TRIAL_BRIDGE_HPP
#define HEADER_WASM_TIME_TRIAL_BRIDGE_HPP

#include <cstdint>
#include <string>
#include <vector>

/**
 * Native C++ <-> JS bridge for Discord Activity Time Trial challenges.
 *
 * When the Activity is launched from a /timetrial Discord embed button,
 * `initFromJS()` loads the prepared challenge configuration and pre-downloaded
 * MEMFS ghost replay paths. STK skips the main menu, opens Kart Selection,
 * races against up to 20 ghosts (+ the player's own PB), uploads finished
 * replays asynchronously on the main thread, and refreshes ghosts on Restart.
 *
 * On non-Emscripten / server-only builds, all methods are safe no-ops.
 */
class WasmTimeTrialBridge
{
private:
    bool                     m_challenge_mode;
    std::string              m_challenge_id;
    std::string              m_track;
    int                      m_difficulty;
    int                      m_laps;
    bool                     m_reverse;
    std::string              m_self_name;
    std::string              m_self_avatar;
    std::vector<std::string> m_ghost_files;
    std::vector<std::string> m_ghost_names;
    std::vector<std::string> m_ghost_avatars;

    uint32_t                 m_next_req_id;
    uint32_t                 m_pending_refresh_req_id;
    uint32_t                 m_pending_submit_req_id;
    bool                     m_refresh_in_flight;

    WasmTimeTrialBridge();

    void parsePreparedJson(const std::string& json);

public:
    static WasmTimeTrialBridge* get();

    /** Reads any prepared Time Trial challenge from JS on startup. */
    void initFromJS();

    bool isChallengeMode() const { return m_challenge_mode; }
    bool isRefreshInFlight() const { return m_refresh_in_flight; }

    const std::string& getChallengeId() const { return m_challenge_id; }
    const std::string& getTrack() const { return m_track; }
    const std::string& getSelfName() const { return m_self_name; }
    const std::string& getSelfAvatarPath() const { return m_self_avatar; }
    int getDifficulty() const { return m_difficulty; }
    int getLaps() const { return m_laps; }
    bool getReverse() const { return m_reverse; }

    /** Loads all downloaded ghosts into ReplayPlay and starts the Time Trial. */
    void startChallengeRace();

    /** Uploads a finished Time Trial .replay file to the Worker API. */
    void submitCompletedRun(const std::string& replay_full_path,
                            const std::string& kart_ident,
                            float kart_color,
                            float finish_time_sec,
                            int replay_version);

    /** Requests updated ghosts from the Worker API and restarts the race. */
    void refreshGhostsAndRestart();

    /** Internal callbacks invoked from JS via EMSCRIPTEN_KEEPALIVE entrypoints. */
    void onGhostsReady(uint32_t req_id, int http_status, const std::string& json);
    void onSubmitResult(uint32_t req_id, int http_status, const std::string& json);
};

#endif
