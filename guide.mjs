/**
 * LoreMax routing guide: which workflow for which task, shown in loremax_workflows
 * (the loremax counterpart of the media plugin's `media-generation` wiki page).
 *
 *   rules:     model-agnostic rules of thumb, shown with every full list
 *   workflows: { "<key>": { use_for, knobs, caveats } } — key is the workflow's
 *              visual_id, else "id:<numeric id>"
 *   routes:    [{ task, pick: [keys, best first] }]
 *
 * The guide is always intersected with the live catalog: an entry whose workflow
 * the organization (or the profile) lacks is never shown, and a route with no
 * live pick is dropped. A studio's profile instructions and its tools' own
 * descriptions take precedence over it.
 *
 * Update flow: re-export the catalog (public fields of the workflows available to
 * all organizations) to docs/catalog/loremax-workflows.json (git-ignored, never
 * committed) → compare it against this file → update the entries → release.
 * This repository is public: no organization-specific names, provider URLs,
 * prices or internal settings here.
 */
export const GUIDE = {
  rules: [
    "Read a workflow's inputs (or a profile tool's schema) before every paid call.",
    "A character that must stay the same across images: make ONE base card at top quality, then vary it through references — never regenerate the character from a prompt each time.",
    "Aspect ratio follows the placement: 9:16 for stories/reels, 1:1 for avatars and grids, 16:9 for covers; set it explicitly, defaults differ per workflow.",
    "Game assets (a sprite, a part, an icon): a transparent background where the workflow offers one, not a flat backdrop to cut out later.",
    "Text inside the picture: only workflows whose guide says they render text.",
    "Preview at the cheapest duration/resolution, then commit the real settings with the same seed where the workflow takes one.",
    "Video is generated, not assembled: one take per scene, never a chain of short stubs glued together.",
    "Look at what you made before handing it over (watch a clip with video_understand).",
    "Cheap or draft workflows only when someone asked for cheap or draft.",
  ],
  workflows: {},
  routes: [],
};
