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

#include "graphics/discord_avatar_manager.hpp"

#include "karts/abstract_kart.hpp"
#include "karts/ghost_kart.hpp"
#include "utils/string_utils.hpp"

#include <algorithm>
#include <cctype>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#ifndef SERVER_ONLY
#include "font/bold_face.hpp"
#include "font/font_manager.hpp"
#include "graphics/central_settings.hpp"
#include "graphics/irr_driver.hpp"
#include "graphics/stk_text_billboard.hpp"
#include "guiengine/engine.hpp"
#include "guiengine/skin.hpp"
#include <ISceneNode.h>
#endif

// ----------------------------------------------------------------------------
std::string DiscordAvatarManager::normalizeUsername(const std::string& utf8)
{
    std::string out = utf8;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return (char)std::tolower(c); });
    return out;
}   // normalizeUsername

// ----------------------------------------------------------------------------
irr::video::ITexture* DiscordAvatarManager::resolveTexture(Entry& e)
{
#ifndef SERVER_ONLY
    if (GUIEngine::isNoGraphics() || e.avatar_path.empty())
        return nullptr;
    if (!e.texture_attempted)
    {
        e.texture_attempted = true;
        e.texture = irr_driver->getTexture(e.avatar_path);
    }
    return e.texture;
#else
    (void)e;
    return nullptr;
#endif
}   // resolveTexture

// ----------------------------------------------------------------------------
DiscordAvatarManager* DiscordAvatarManager::get()
{
    static DiscordAvatarManager instance;
    return &instance;
}   // get

// ----------------------------------------------------------------------------
void DiscordAvatarManager::syncParticipantsFromJS()
{
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (globalThis.stkDiscordParticipants &&
            typeof globalThis.stkDiscordParticipants.flushToWasm === "function")
        {
            globalThis.stkDiscordParticipants.flushToWasm();
        }
    });
#endif
}   // syncParticipantsFromJS

// ----------------------------------------------------------------------------
void DiscordAvatarManager::clearAll()
{
    m_replay_meta.clear();
    m_kart_entries.clear();
}   // clearAll

// ----------------------------------------------------------------------------
void DiscordAvatarManager::clearKartBindings()
{
    m_kart_entries.clear();
}   // clearKartBindings

// ----------------------------------------------------------------------------
void DiscordAvatarManager::registerReplayMeta(const std::string& replay_path,
                                              const std::string& display_name_utf8,
                                              const std::string& avatar_path)
{
    if (replay_path.empty()) return;
    Entry e;
    e.display_name_utf8 = display_name_utf8;
    e.avatar_path = avatar_path;
    m_replay_meta[replay_path] = std::move(e);
}   // registerReplayMeta

// ----------------------------------------------------------------------------
void DiscordAvatarManager::registerParticipant(const std::string& username_utf8,
                                               const std::string& display_name_utf8,
                                               const std::string& avatar_path)
{
    if (username_utf8.empty()) return;
    std::string key = normalizeUsername(username_utf8);
    Entry e;
    e.display_name_utf8 = display_name_utf8;
    e.avatar_path = avatar_path;
    m_username_meta[key] = std::move(e);
    m_version++;
}   // registerParticipant

// ----------------------------------------------------------------------------
void DiscordAvatarManager::bindKart(unsigned int world_kart_id,
                                    const std::string& display_name_utf8,
                                    const std::string& avatar_path)
{
    Entry e;
    e.display_name_utf8 = display_name_utf8;
    e.avatar_path = avatar_path;
    m_kart_entries[world_kart_id] = std::move(e);
}   // bindKart

// ----------------------------------------------------------------------------
void DiscordAvatarManager::bindKartByUsername(AbstractKart* kart,
                                              const irr::core::stringw& username,
                                              bool attach_avatar_billboard)
{
    if (!kart || username.empty()) return;
    std::string key = normalizeUsername(StringUtils::wideToUtf8(username));
    auto it = m_username_meta.find(key);
    if (it == m_username_meta.end()) return;

    const Entry& meta = it->second;
    bindKart(kart->getWorldKartId(), meta.display_name_utf8, meta.avatar_path);

#ifndef SERVER_ONLY
    if (attach_avatar_billboard && !GUIEngine::isNoGraphics() &&
        !meta.avatar_path.empty() && kart->getNode())
    {
        irr::scene::ISceneNode* avatar_node = irr_driver->addBillboard(
            irr::core::dimension2d<irr::f32>(0.75f, 0.75f),
            meta.avatar_path,
            kart->getNode());
        if (avatar_node)
        {
            avatar_node->setPosition(irr::core::vector3df(0.0f, 2.35f, 0.0f));
        }
    }
#else
    (void)attach_avatar_billboard;
#endif
}   // bindKartByUsername

// ----------------------------------------------------------------------------
irr::core::stringw DiscordAvatarManager::getReplayDisplayName(
    const std::string& replay_path) const
{
    auto it = m_replay_meta.find(replay_path);
    if (it == m_replay_meta.end() || it->second.display_name_utf8.empty())
        return L"";
    return StringUtils::utf8ToWide(it->second.display_name_utf8);
}   // getReplayDisplayName

// ----------------------------------------------------------------------------
irr::video::ITexture* DiscordAvatarManager::getAvatarTextureForUsername(
    const irr::core::stringw& username)
{
    if (username.empty()) return nullptr;
    std::string key = normalizeUsername(StringUtils::wideToUtf8(username));
    auto it = m_username_meta.find(key);
    if (it == m_username_meta.end()) return nullptr;
    return resolveTexture(it->second);
}   // getAvatarTextureForUsername

// ----------------------------------------------------------------------------
irr::core::stringw DiscordAvatarManager::getDisplayNameForUsername(
    const irr::core::stringw& username) const
{
    if (username.empty()) return L"";
    std::string key = normalizeUsername(StringUtils::wideToUtf8(username));
    auto it = m_username_meta.find(key);
    if (it == m_username_meta.end() || it->second.display_name_utf8.empty())
        return L"";
    return StringUtils::utf8ToWide(it->second.display_name_utf8);
}   // getDisplayNameForUsername

// ----------------------------------------------------------------------------
irr::video::ITexture* DiscordAvatarManager::getAvatarTextureForKart(
    const AbstractKart* kart)
{
    if (!kart) return nullptr;
    auto it = m_kart_entries.find(kart->getWorldKartId());
    if (it == m_kart_entries.end()) return nullptr;
    return resolveTexture(it->second);
}   // getAvatarTextureForKart

// ----------------------------------------------------------------------------
irr::core::stringw DiscordAvatarManager::getDisplayNameForKart(
    const AbstractKart* kart) const
{
    if (!kart) return L"";
    auto it = m_kart_entries.find(kart->getWorldKartId());
    if (it == m_kart_entries.end() || it->second.display_name_utf8.empty())
        return L"";
    return StringUtils::utf8ToWide(it->second.display_name_utf8);
}   // getDisplayNameForKart

// ----------------------------------------------------------------------------
void DiscordAvatarManager::attachGhostBillboards(GhostKart* ghost,
                                                 const std::string& replay_path)
{
#ifndef SERVER_ONLY
    if (!ghost || GUIEngine::isNoGraphics()) return;

    auto it = m_replay_meta.find(replay_path);
    if (it == m_replay_meta.end()) return;

    const Entry& meta = it->second;
    bindKart(ghost->getWorldKartId(), meta.display_name_utf8, meta.avatar_path);

    irr::scene::ISceneNode* parent = ghost->getNode();
    if (!parent) return;

    // 1. 3D floating name billboard (STKTextBillboard, same style as Kart::setOnScreenText)
    if (!meta.display_name_utf8.empty())
    {
        irr::core::stringw wide_name = StringUtils::utf8ToWide(meta.display_name_utf8);
        BoldFace* bold_face = font_manager->getFont<BoldFace>();
        if (bold_face && GUIEngine::getSkin())
        {
            STKTextBillboard* tb = new STKTextBillboard(
                GUIEngine::getSkin()->getColor("font::bottom"),
                GUIEngine::getSkin()->getColor("font::top"),
                parent, irr_driver->getSceneManager(), -1,
                irr::core::vector3df(0.0f, 1.55f, 0.0f),
                irr::core::vector3df(0.45f, 0.45f, 0.45f));
            if (CVS->isGLSL())
                tb->init(wide_name, bold_face);
            else
                tb->initLegacy(wide_name, bold_face);
            tb->drop();
        }
    }

    // 2. 3D circular Discord avatar billboard stacked cleanly above the name
    if (!meta.avatar_path.empty())
    {
        irr::scene::ISceneNode* avatar_node = irr_driver->addBillboard(
            irr::core::dimension2d<irr::f32>(0.75f, 0.75f),
            meta.avatar_path,
            parent);
        if (avatar_node)
        {
            avatar_node->setPosition(irr::core::vector3df(0.0f, 2.35f, 0.0f));
        }
    }
#else
    (void)ghost;
    (void)replay_path;
#endif
}   // attachGhostBillboards

// ----------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
extern "C"
{

EMSCRIPTEN_KEEPALIVE void stk_discord_register_participant(
    const char* username_utf8,
    const char* display_name_utf8,
    const char* avatar_path)
{
    DiscordAvatarManager::get()->registerParticipant(
        username_utf8 ? std::string(username_utf8) : std::string(),
        display_name_utf8 ? std::string(display_name_utf8) : std::string(),
        avatar_path ? std::string(avatar_path) : std::string());
}

}   // extern "C"
#endif
