import { auth, defineMcp } from "@lovable.dev/mcp-js";
import getMyProfile from "./tools/get-my-profile";
import updateMyProfile from "./tools/update-my-profile";
import listMyPosts from "./tools/list-my-posts";
import createPost from "./tools/create-post";
import listNotifications from "./tools/list-notifications";

// The OAuth issuer must be the direct Supabase host, built from the project ref
// (inlined at build time), never from SUPABASE_URL.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "forsure-mcp",
  title: "ForSure",
  version: "0.1.0",
  instructions:
    "Outils du réseau social ForSure pour l'utilisateur connecté : lire et mettre à jour son profil, lister ses publications, publier (ou programmer) un post et consulter ses notifications. Toutes les actions s'exécutent au nom de l'utilisateur authentifié.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [getMyProfile, updateMyProfile, listMyPosts, createPost, listNotifications],
});
