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

#ifndef HEADER_DISCORD_AVATAR_MANAGER_HPP
#define HEADER_DISCORD_AVATAR_MANAGER_HPP

#include "irrString.h"

#include <cstdint>
#include <string>
#include <unordered_map>

namespace irr { namespace video { class ITexture; } }

class AbstractKart;
class GhostKart;

/**
 * Single source of truth for Discord player identity and circular avatars in STK.
 *
 * Canonical player names throughout STK (profiles, ENet lobby packets, chat,
 * karts, and replays) use Discord's `<@user_id>` mention token.
 *
 * - `resolveMentions()` is hooked centrally at the font rendering boundary
 *   (FontManager / FontWithFace) so EVERY 2D and 3D text surface automatically
 *   renders the user's current guild/global display name.
 * - `getAvatarTextureForText()` / `getAvatarTextureForKart()` extract the
 *   `<@user_id>` token and resolve the cached circular MEMFS PNG texture.
 */
class DiscordAvatarManager
{
public:
    struct UserEntry
    {
        std::string display_name_utf8;
        irr::core::stringw display_name_wide;
        std::string avatar_path;
        irr::video::ITexture* texture = nullptr;
        bool texture_attempted = false;
    };

private:
    std::unordered_map<std::string, UserEntry> m_users_by_id;
    std::unordered_map<std::string, std::string> m_replay_controller_names;
    uint64_t m_version = 0;

    DiscordAvatarManager() = default;

    static irr::video::ITexture* resolveTexture(UserEntry& e);

public:
    static DiscordAvatarManager* get();

    /** Monotonic counter incremented whenever user metadata changes. */
    uint64_t getVersion() const { return m_version; }

    /** Flushes any Discord Activity participants already fetched in JS. */
    void syncParticipantsFromJS();

    /** Clears per-challenge replay -> mention mappings (preserves cached users). */
    void clearReplayMappings();

    /** Registers or updates a Discord user's display name and MEMFS avatar path. */
    void registerUser(const std::string& user_id,
                      const std::string& display_name_utf8,
                      const std::string& avatar_path);

    /** Maps a downloaded Time Trial replay path to its canonical `<@user_id>` (or `<@user_id> (PB)`) name. */
    void registerReplayControllerName(const std::string& replay_path,
                                      const std::string& controller_name_utf8);

    /** Returns the canonical controller name registered for a replay path (or empty). */
    irr::core::stringw getReplayControllerName(const std::string& replay_path) const;

    /** Extracts the first `<@(\d+)>` Discord user ID from text, or returns empty string. */
    static std::string extractDiscordId(const irr::core::stringw& text);

    /**
     * Replaces every `<@(\d+)>` mention token in `text` with the user's registered
     * display name (or "Player" if not yet synced). Zero-allocation fast path when
     * `text` contains no `<@` sequence.
     */
    irr::core::stringw resolveMentions(const irr::core::stringw& text) const;

    /** Returns the circular Discord avatar texture for a `<@user_id>` string, or nullptr. */
    irr::video::ITexture* getAvatarTextureForText(const irr::core::stringw& text);

    /** Returns the circular Discord avatar texture for a kart (via its controller name), or nullptr. */
    irr::video::ITexture* getAvatarTextureForKart(const AbstractKart* kart);

    /** Attaches a 3D circular Discord avatar billboard above a kart (if `<@id>` has an avatar). */
    void attachAvatarBillboard(AbstractKart* kart);

    /** Attaches 3D name (`STKTextBillboard`) + circular avatar billboard above a GhostKart. */
    void attachGhostBillboards(GhostKart* ghost);
};

#endif
