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

#include <string>
#include <unordered_map>

namespace irr { namespace video { class ITexture; } }

class AbstractKart;
class GhostKart;

/**
 * Shared registry mapping karts (Time Trial ghosts now; multiplayer karts in Step 2)
 * to their Discord display name and circular avatar texture loaded from MEMFS.
 */
class DiscordAvatarManager
{
public:
    struct Entry
    {
        std::string display_name_utf8;
        std::string avatar_path;
        irr::video::ITexture* texture = nullptr;
        bool texture_attempted = false;
    };

private:
    std::unordered_map<std::string, Entry> m_replay_meta;
    std::unordered_map<unsigned int, Entry> m_kart_entries;

    DiscordAvatarManager() = default;

public:
    static DiscordAvatarManager* get();

    /** Clears all replay metadata and per-kart bindings. */
    void clearAll();

    /** Clears only per-kart bindings (keeping replay metadata for Restart). */
    void clearKartBindings();

    /** Registers Discord display name and MEMFS avatar path for a replay file. */
    void registerReplayMeta(const std::string& replay_path,
                            const std::string& display_name_utf8,
                            const std::string& avatar_path);

    /** Binds a world kart ID directly to a Discord display name and MEMFS avatar path. */
    void bindKart(unsigned int world_kart_id,
                  const std::string& display_name_utf8,
                  const std::string& avatar_path);

    /** Returns the Discord display name registered for a replay path (or empty). */
    irr::core::stringw getReplayDisplayName(const std::string& replay_path) const;

    /** Returns the circular Discord avatar texture for a kart, or nullptr if none. */
    irr::video::ITexture* getAvatarTextureForKart(const AbstractKart* kart);

    /** Returns the Discord display name for a kart, or empty string if none. */
    irr::core::stringw getDisplayNameForKart(const AbstractKart* kart) const;

    /**
     * Binds a GhostKart's world ID and attaches real 3D billboards (name + circular
     * Discord avatar stacked above) parented to the ghost kart's scene node.
     */
    void attachGhostBillboards(GhostKart* ghost, const std::string& replay_path);
};

#endif
