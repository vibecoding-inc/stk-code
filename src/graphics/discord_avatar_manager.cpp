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
#include "karts/controller/controller.hpp"
#include "karts/ghost_kart.hpp"
#include "utils/log.hpp"
#include "utils/string_utils.hpp"

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
irr::video::ITexture* DiscordAvatarManager::resolveTexture(const UserEntry& e)
{
#ifndef SERVER_ONLY
    if (GUIEngine::isNoGraphics() || !irr_driver || e.avatar_path.empty())
        return nullptr;
    // Always query STKTexManager via irr_driver->getTexture() rather than
    // caching a raw non-owning ITexture* here: IrrDriver::addBillboard()
    // creates a temporary Material whose destructor unloads and removes the
    // texture from STKTexManager during Track::cleanup() / popTempMaterial(),
    // which would leave a cached raw pointer dangling on the next race.
    // STKTexManager already caches loaded textures (and failed lookups) in O(1).
    return irr_driver->getTexture(e.avatar_path);
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
void DiscordAvatarManager::clearReplayMappings()
{
    m_replay_controller_names.clear();
}   // clearReplayMappings

// ----------------------------------------------------------------------------
void DiscordAvatarManager::registerUser(const std::string& user_id,
                                        const std::string& display_name_utf8,
                                        const std::string& avatar_path)
{
    if (user_id.empty()) return;
    UserEntry& e = m_users_by_id[user_id];
    if (!display_name_utf8.empty())
    {
        e.display_name_utf8 = display_name_utf8;
        e.display_name_wide = StringUtils::utf8ToWide(display_name_utf8);
    }
    if (!avatar_path.empty() && avatar_path != e.avatar_path)
    {
        e.avatar_path = avatar_path;
    }
    m_version++;
    Log::info("DiscordAvatarManager",
              "Registered user '%s' (display='%s', avatar='%s').",
              user_id.c_str(), e.display_name_utf8.c_str(), e.avatar_path.c_str());
}   // registerUser

// ----------------------------------------------------------------------------
void DiscordAvatarManager::registerReplayControllerName(
    const std::string& replay_path,
    const std::string& controller_name_utf8)
{
    if (replay_path.empty() || controller_name_utf8.empty()) return;
    m_replay_controller_names[replay_path] = controller_name_utf8;
}   // registerReplayControllerName

// ----------------------------------------------------------------------------
irr::core::stringw DiscordAvatarManager::getReplayControllerName(
    const std::string& replay_path) const
{
    auto it = m_replay_controller_names.find(replay_path);
    if (it == m_replay_controller_names.end())
        return L"";
    return StringUtils::utf8ToWide(it->second);
}   // getReplayControllerName

// ----------------------------------------------------------------------------
std::string DiscordAvatarManager::extractDiscordId(const irr::core::stringw& text)
{
    const irr::s32 start = text.find(L"<@");
    if (start < 0) return "";

    const irr::u32 len = text.size();
    irr::u32 pos = (irr::u32)start + 2;
    std::string id;
    while (pos < len)
    {
        wchar_t ch = text[pos];
        if (ch >= L'0' && ch <= L'9')
        {
            id.push_back((char)ch);
            pos++;
        }
        else if (ch == L'>' && !id.empty())
        {
            return id;
        }
        else
        {
            return "";
        }
    }
    return "";
}   // extractDiscordId

// ----------------------------------------------------------------------------
irr::core::stringw DiscordAvatarManager::resolveMentions(
    const irr::core::stringw& text) const
{
    if (text.find(L"<@") < 0)
        return text;

    irr::core::stringw out;
    const irr::u32 len = text.size();
    irr::u32 i = 0;
    while (i < len)
    {
        if (i + 2 < len && text[i] == L'<' && text[i + 1] == L'@')
        {
            irr::u32 j = i + 2;
            std::string id;
            while (j < len && text[j] >= L'0' && text[j] <= L'9')
            {
                id.push_back((char)text[j]);
                j++;
            }
            if (!id.empty() && j < len && text[j] == L'>')
            {
                auto it = m_users_by_id.find(id);
                if (it != m_users_by_id.end() && !it->second.display_name_wide.empty())
                {
                    out += it->second.display_name_wide;
                }
                else
                {
                    out += L"Player";
                }
                i = j + 1;
                continue;
            }
        }
        out.append(text[i]);
        i++;
    }
    return out;
}   // resolveMentions

// ----------------------------------------------------------------------------
irr::video::ITexture* DiscordAvatarManager::getAvatarTextureForText(
    const irr::core::stringw& text)
{
    std::string id = extractDiscordId(text);
    if (id.empty()) return nullptr;
    auto it = m_users_by_id.find(id);
    if (it == m_users_by_id.end()) return nullptr;
    return resolveTexture(it->second);
}   // getAvatarTextureForText

// ----------------------------------------------------------------------------
irr::video::ITexture* DiscordAvatarManager::getAvatarTextureForKart(
    const AbstractKart* kart)
{
    if (!kart || !kart->getController()) return nullptr;
    return getAvatarTextureForText(kart->getController()->getName());
}   // getAvatarTextureForKart

// ----------------------------------------------------------------------------
void DiscordAvatarManager::attachAvatarBillboard(AbstractKart* kart)
{
#ifndef SERVER_ONLY
    if (!kart || !kart->getController() || !kart->getNode() || GUIEngine::isNoGraphics())
        return;

    std::string id = extractDiscordId(kart->getController()->getName());
    if (id.empty()) return;

    auto it = m_users_by_id.find(id);
    if (it == m_users_by_id.end() || it->second.avatar_path.empty())
        return;

    irr::scene::ISceneNode* avatar_node = irr_driver->addBillboard(
        irr::core::dimension2d<irr::f32>(0.75f, 0.75f),
        it->second.avatar_path,
        kart->getNode());
    if (avatar_node)
    {
        avatar_node->setPosition(irr::core::vector3df(0.0f, 2.35f, 0.0f));
    }
    else
    {
        Log::warn("DiscordAvatarManager",
                  "Failed to create 3D avatar billboard for user '%s' ('%s').",
                  id.c_str(), it->second.avatar_path.c_str());
    }
#else
    (void)kart;
#endif
}   // attachAvatarBillboard

// ----------------------------------------------------------------------------
void DiscordAvatarManager::attachGhostBillboards(GhostKart* ghost)
{
#ifndef SERVER_ONLY
    if (!ghost || !ghost->getController() || !ghost->getNode() || GUIEngine::isNoGraphics())
        return;

    irr::core::stringw name = ghost->getController()->getName();
    if (!name.empty())
    {
        BoldFace* bold_face = font_manager->getFont<BoldFace>();
        if (bold_face && GUIEngine::getSkin())
        {
            STKTextBillboard* tb = new STKTextBillboard(
                GUIEngine::getSkin()->getColor("font::bottom"),
                GUIEngine::getSkin()->getColor("font::top"),
                ghost->getNode(), irr_driver->getSceneManager(), -1,
                irr::core::vector3df(0.0f, 1.55f, 0.0f),
                irr::core::vector3df(0.45f, 0.45f, 0.45f));
            if (CVS->isGLSL())
                tb->init(name, bold_face);
            else
                tb->initLegacy(name, bold_face);
            tb->drop();
        }
    }

    attachAvatarBillboard(ghost);
#else
    (void)ghost;
#endif
}   // attachGhostBillboards

// ----------------------------------------------------------------------------
#ifdef __EMSCRIPTEN__
extern "C"
{

EMSCRIPTEN_KEEPALIVE void stk_discord_register_user(
    const char* user_id,
    const char* display_name_utf8,
    const char* avatar_path)
{
    DiscordAvatarManager::get()->registerUser(
        user_id ? std::string(user_id) : std::string(),
        display_name_utf8 ? std::string(display_name_utf8) : std::string(),
        avatar_path ? std::string(avatar_path) : std::string());
}

}   // extern "C"
#endif
