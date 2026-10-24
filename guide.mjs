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
    "Text inside the picture: only workflows whose description or guide says they render text.",
    "Preview at the cheapest duration/resolution, then commit the real settings with the same seed where the workflow takes one.",
    "Video is generated, not assembled: one take per scene, never a chain of short stubs glued together.",
    "Look at what you made before handing it over (watch a clip with video_understand).",
    "Cheap or draft workflows only when someone asked for cheap or draft.",
  ],
  workflows: {
    // --- image: generation ---
    "t2i_gpt_image_2.5": {
      use_for: "strongest all-round image: key art, game assets, base cards, text in image",
      knobs: "model Flare (fast) or Sunburst (finest detail, slower); quality low…max (max for finals and base cards); background transparent for assets; image_size up to 3840",
      caveats: "Sunburst at max quality is slow: settle the prompt on Flare first. No seed: keep a good file instead of trying to repeat it.",
    },
    "t2i_gpt_image_15": {
      use_for: "transparent-background assets when GPT Image 2.5 is unavailable",
      knobs: "background transparent; quality; image_size 1024 or 1536 only",
      caveats: "older model, at most 1536 px",
    },
    "Text2Image_NanoBanana_2": {
      use_for: "detailed illustration and concept art in any style, up to 4K",
      knobs: "resolution 1K/2K/4K (default 4K); aspect_ratio 21:9…9:16",
      caveats: "no transparent background",
    },
    "t2i_flux_3_image": {
      use_for: "sharp 2K/4K images with precise layout and lettering",
      knobs: "resolution 1k/2k/4k; aspect_ratio 21:9…9:16; safety_tolerance",
    },
    "Text2Image_SeeDream_5_pro": {
      use_for: "posters and ad layouts with dense, multilingual typography",
      knobs: "image_size 1024–2048",
      caveats: "at most 2K",
    },
    "t2i_qwen_image_3": {
      use_for: "infographics, packaging, posters with legible small type",
      knobs: "model standard or pro (pro for small type); image_size up to 2048; seed",
    },
    "t2i_flux_2_max": {
      use_for: "premium photoreal product, catalogue and print images",
      knobs: "size",
    },
    "Text2Image_Loremax_Casual_Art": {
      use_for: "casual mobile-game art: 3D cartoon characters, mascots, items",
      knobs: "mode_name (style); size; lora_lightning",
    },
    "Text2Image_Loremode_UniversalGameModel": {
      use_for: "friendly 3D casual-game characters and props",
      knobs: "size; lora_lightning",
    },
    "Text2Image_Vector_Graphics": {
      use_for: "flat vector-style icons, UI elements, 2D characters",
      knobs: "size; lora_lightning",
      caveats: "the output is a raster in vector style: run i2i_vectorize on it for a real SVG",
    },
    "Text2Image_NanoBanana_v2": {
      use_for: "fast, reliable drafts, storyboards and volume work",
      knobs: "resolution 0.5K–4K; aspect_ratio",
      caveats: "draft tier: only when someone asked for cheap or fast; no transparent background",
    },
    "Text2Image_NanoBanana_lite": {
      use_for: "near-instant throwaway sketches",
      knobs: "aspect_ratio; seed",
      caveats: "lowest-quality tier: only when someone asked for it; no transparent background",
    },
    // --- image: editing and processing ---
    "i2i_gpt_image_2.5": {
      use_for: "edit or vary an image by instruction, the rest stays intact",
      knobs: "model Flare or Sunburst; quality; background transparent; image_size",
      caveats: "say what must not change; vary the same base card each time, not the previous variation",
    },
    "Image2Image_NanoBanana_Edit_v2": {
      use_for: "fast, reliable edits and variations from reference images, up to 4K",
      knobs: "resolution 0.5K–4K (default 1K); aspect_ratio auto or 21:9…9:16",
      caveats: "no transparent background",
    },
    "Loremax_Image_Scene_builder": {
      use_for: "compose a scene from several references with a chosen image model",
      knobs: "alternative_model (GPT Image 2.5, NanoBanana Pro or 2, Seedream 5 Pro…); model_gpt Flare/Sunburst; quality; aspect_ratio",
      caveats: "takes a structured prompt (Prompt Editor V2): read its input fields first; a profile cannot hold it, so REST mode only",
    },
    "i2i_flux_3_image": {
      use_for: "local edits and variations from up to 10 references, identity kept",
      knobs: "resolution 1k/2k/4k; aspect_ratio",
    },
    "i2i_qwen_image_3_edit": {
      use_for: "merge references, swap objects, rewrite text; faces kept",
      knobs: "model; image_size",
    },
    "Image2Image_SeeDream_5_pro_edit": {
      use_for: "change one region (product, label, logo), keep the rest",
      knobs: "image_size; up to 10 references",
    },
    "i2i_qwen-image-edit-2511-multiple-angles": {
      use_for: "the same subject from another camera angle or zoom",
      knobs: "size",
      caveats: "simulated views, not a 3D model: check proportions",
    },
    "i2i_qwen-image-edit-fusion": {
      use_for: "place one product or subject into a new scene, light matched",
      knobs: "aspect_ratio",
    },
    "i2i_vectorize": {
      use_for: "convert a raster logo, icon or illustration to SVG",
      caveats: "clean flat art vectorizes well; a photo gives a heavy, noisy SVG",
    },
    "Image2Image_Outpaint": {
      use_for: "extend the canvas to another aspect ratio, subject kept",
      knobs: "aspect_ratio; creative",
    },
    "Rembg_bria": {
      use_for: "cut an object out onto a transparent background",
    },
    "Image2Image_SeeDream_5_layerize": {
      use_for: "split a finished image into named transparent PNG layers",
      knobs: "layers_number 2–17",
    },
    "Image2Image_ImageTranslate": {
      use_for: "translate the text inside an image, design kept",
      knobs: "target_language; translation_mode; font_adaptation",
    },
    "Image2Image_topaz_upscale_wonder_35": {
      use_for: "highest-detail generative upscale of photos and renders",
      knobs: "model; scale; face_enhancment",
    },
    "Upscale_Topaz": {
      use_for: "faithful upscale up to 4× that invents nothing",
      knobs: "upscale_factor",
    },
    "Image2Image_topaz_upscale_transparent": {
      use_for: "4× upscale that keeps the alpha channel (logos, sprites)",
      caveats: "always exactly 4×",
    },
    // --- video: generation ---
    "i2v_seedance_25": {
      use_for: "animate a still or a first+last frame: one take up to 30 s, with sound",
      knobs: "duration 4–30; resolution 480p (draft) / 720p / 1080p; generate_audio; seed",
      caveats: "refusals are common, mostly real-looking faces as the frame: for photoreal people use the UGC reference workflow; check every result",
    },
    "t2v_seedance_25": {
      use_for: "text to one continuous take up to 30 s with lip-synced audio",
      knobs: "duration 4–30; resolution 480p/720p/1080p; aspect_ratio; generate_audio; seed",
      caveats: "preview at 480p with a fixed seed, then commit the real settings with the same seed",
    },
    "r2v_seedance_25": {
      use_for: "a locked cast, set and palette from references, up to 30 s",
      knobs: "duration 4–30; resolution; aspect_ratio; generate_audio; seed; references are looks to keep, not frames",
      caveats: "a real-looking face as a reference can be refused: use the UGC variant for photoreal people",
    },
    "r2v_seedance_25-copy-1787570239620-fysq": {
      use_for: "reference video with photoreal people: faces hold in close-ups",
      knobs: "duration 4–30; resolution; aspect_ratio; generate_audio; seed",
    },
    "i2v_wan_27": {
      use_for: "dependable image to video, scene kept faithfully, up to 15 s",
      knobs: "resolution 720p/1080p; duration 2–15",
      caveats: "no audio setting: add sound separately when the clip needs it",
    },
    "i2v_grok_imagine_video": {
      use_for: "quick, dependable clips from an image, 1–15 s",
      knobs: "model_type; duration 1–15; resolution 480p/720p; aspect_ratio",
    },
    "i2v_kling_v3": {
      use_for: "image to video with strong motion and camera work, up to 15 s",
      knobs: "model_type standard/pro/4k; duration 3–15; aspect_ratio; generate_audio; shot_type",
    },
    "t2v_kling_v3": {
      use_for: "multi-shot text-to-video with consistent characters, up to 15 s",
      knobs: "model_type standard/pro/4k; duration 3–15; aspect_ratio; generate_audio; shot_type",
    },
    "img2video_gemini_omni": {
      use_for: "cinematic realism with voices and sound, from an image",
      knobs: "duration 4–10; resolution 720p/1080p/4k; aspect_ratio 16:9 or 9:16; seed",
    },
    "txt2video_gemini_omni": {
      use_for: "cinematic realistic clips with voices, from text",
      knobs: "duration 4–10; resolution 720p/1080p/4k; aspect_ratio 16:9 or 9:16; seed",
    },
    "r2v_wan_3": {
      use_for: "keep a subject's identity from a reference image or video",
      knobs: "resolution; aspect_ratio; duration; need_audio; seed",
    },
    "i2v_grok_imagine_reference": {
      use_for: "quick clips from several reference images",
      knobs: "duration_15 1–15; resolution 480p/720p; aspect_ratio",
    },
    "v2v_kling_3_motion_control": {
      use_for: "move a character image the way a reference video moves",
      knobs: "orientation; model_type; with_audio",
    },
    "image2video_seedance_2_start_end_frame": {
      use_for: "morphs and before/after reveals between two keyframes",
      knobs: "duration 4–15; resolution; generate_audio; seed",
    },
    "i2v_kling_o3-start_end_frame": {
      use_for: "controlled transition from a start to an end frame",
      knobs: "duration 3–15; model_type standard/pro; generate_audio",
    },
    "pruna_p-video-2-pro-avatar": {
      use_for: "talking avatar from one portrait and audio or a script, up to 3 min",
      knobs: "resolution; voice_id; language",
    },
    "heygen_avatar_4_video": {
      use_for: "presenter-style avatar with natural expressions, from a photo",
      knobs: "voice_id; expressiveness; aspect_ratio",
    },
    "Image2Video_Wan_22_fast": {
      use_for: "fast low-resolution motion drafts",
      knobs: "number_of_frames; resolution 480p/720p",
      caveats: "draft tier: only when someone asked for cheap or fast",
    },
    // --- video: editing and processing ---
    "a2a_sync_lipsync_api": {
      use_for: "lip-sync a video to new audio, choice of sync models",
      knobs: "model_type (sync-3, lipsync-2-pro, react-1 with emotion_prompt…); sync_mode for when audio and video lengths differ",
      caveats: "fails often: watch every result before handing it over (failed runs are refunded)",
    },
    "a2a_sync_lipsync_v3_dubbing": {
      use_for: "re-sync mouths in an existing video to new speech or a dub",
      knobs: "target_lang",
    },
    "a2a_elevenlabs_dubbing": {
      use_for: "dub speech into another language, timing and emotion kept",
      knobs: "target_lang; output_format",
    },
    "v2v_seedance_2.5": {
      use_for: "restyle, relight or re-dress a video, motion and framing locked",
      knobs: "resolution; generate_audio; seed",
    },
    "video2video_flux_3_edit": {
      use_for: "change one named thing in a clip, the rest untouched",
      caveats: "source clips up to 15 s",
    },
    "v2v_kling_o3": {
      use_for: "restyle a video keeping its motion; images guide the design",
      knobs: "model_type; duration; keep_audio; aspect_ratio",
    },
    "video2video_gemini_omni": {
      use_for: "edit a video with Gemini Omni",
      caveats: "fails very often: prefer v2v_seedance_2.5 or video2video_flux_3_edit",
    },
    "image2video_seedance_2": {
      use_for: "older Seedance 2 image to video",
      caveats: "fails often: prefer i2v_seedance_25",
    },
    "reference2video_seedance_2": {
      use_for: "older Seedance 2 reference video",
      caveats: "fails very often: prefer r2v_seedance_25",
    },
    "video2video_flux_3": {
      use_for: "continue a clip by 5–20 s, matching motion, light and framing",
      knobs: "quality; duration; generate_audio",
    },
    "r2v_minimax_h3_reframe": {
      use_for: "reframe a video to another aspect ratio, edges generated",
      knobs: "aspect_ratio; resolution; seed",
    },
    "v2v_topaz_labs_video_upscale_astra": {
      use_for: "upscale AI-generated video, inventing fine detail",
      knobs: "scale; creativity; realism",
    },
    "v2v_video_veed_background_removal": {
      use_for: "remove the background of a video with people or objects",
      knobs: "subject_is_person; refine_foreground_edges",
    },
    "v2v_bria_erase_prompt": {
      use_for: "erase named objects or people from a video",
      knobs: "auto_trim; preserve_audio",
    },
    // --- audio ---
    "t2a_gemini_38_flash_tts": {
      use_for: "voiceover and narration, 130+ languages, one steady voice",
      knobs: "model; is_dialog; voices / voice_monolog",
    },
    "t2a_elevenlabs_tts_multilingual_v2": {
      use_for: "expressive speech with fine voice control",
      knobs: "voice; stability; similarity_boost; style; speed; language_code",
    },
    "t2a_elevenlabs_text-to-dialogue_eleven-v3_api": {
      use_for: "multi-character dialogue with emotion and intonation",
      knobs: "language; stability; similarity; seed",
    },
    "ref2audio_seed_audio_1": {
      use_for: "speech in a voice cloned from a short reference",
      knobs: "voice; speed; pitch; volume",
    },
    "t2a_suno_create_music": {
      use_for: "full songs with vocals and lyrics from a prompt",
      knobs: "style; instrumental; voice; style_weight",
      caveats: "returns two tracks per generation: listen to both and keep one",
    },
    "t2a_suno_treblo_music": {
      use_for: "full-length song with a target length, lyrics or instrumental",
      knobs: "instrumental; lyric; min_length; max_length",
    },
    "t2a_elevenlabs_sounds": {
      use_for: "sound effects and ambiences",
      knobs: "duration; loop; prompt_influence",
    },
    "t2a_suno_create_sound": {
      use_for: "loopable background music and game audio",
      knobs: "loop; sound_tempo; sound_key",
    },
    "a2a_separate_sam_audio": {
      use_for: "isolate vocals or one sound, remove noise",
    },
    // --- text ---
    "Loremax_Text_Scene_Builder_v1": {
      use_for: "copywriting, translation, narrative and styled text",
    },
  },
  routes: [
    { task: "image: key art, illustration, ad creative", pick: ["t2i_gpt_image_2.5", "Text2Image_NanoBanana_2"] },
    { task: "image: text inside the picture (poster, packaging, UI)", pick: ["t2i_gpt_image_2.5", "Text2Image_SeeDream_5_pro"] },
    { task: "image: game asset or icon, transparent background", pick: ["t2i_gpt_image_2.5", "Rembg_bria"] },
    { task: "image: variations of a character or product", pick: ["i2i_gpt_image_2.5", "Image2Image_NanoBanana_Edit_v2"] },
    { task: "image: the same subject from another angle", pick: ["i2i_qwen-image-edit-2511-multiple-angles"] },
    { task: "image: photoreal product or lifestyle shot", pick: ["t2i_flux_2_max", "i2i_qwen-image-edit-fusion"] },
    { task: "image: casual mobile-game art, 3D mascots", pick: ["Text2Image_Loremax_Casual_Art"] },
    { task: "image: logo or icon as SVG", pick: ["i2i_vectorize", "Text2Image_Vector_Graphics"] },
    { task: "image: edit one thing, keep the rest", pick: ["i2i_gpt_image_2.5", "Image2Image_SeeDream_5_pro_edit"] },
    { task: "image: remove background, split into layers", pick: ["Rembg_bria", "Image2Image_SeeDream_5_layerize"] },
    { task: "image: upscale", pick: ["Image2Image_topaz_upscale_wonder_35", "Image2Image_topaz_upscale_transparent"] },
    { task: "video: from an image or first frame, one take", pick: ["i2v_seedance_25", "i2v_wan_27", "i2v_kling_v3"] },
    { task: "video: from text", pick: ["t2v_seedance_25", "t2v_kling_v3"] },
    { task: "video: fixed cast or set across a series", pick: ["r2v_seedance_25", "r2v_wan_3"] },
    { task: "video: photoreal people and faces", pick: ["r2v_seedance_25-copy-1787570239620-fysq", "img2video_gemini_omni"] },
    { task: "video: motion copied from a reference video", pick: ["v2v_kling_3_motion_control"] },
    { task: "video: from a start frame to an end frame", pick: ["image2video_seedance_2_start_end_frame", "i2v_kling_o3-start_end_frame"] },
    { task: "video: talking avatar from a portrait", pick: ["heygen_avatar_4_video", "pruna_p-video-2-pro-avatar"] },
    { task: "video: lip-sync or dub a video", pick: ["a2a_sync_lipsync_api", "a2a_elevenlabs_dubbing"] },
    { task: "video: edit or restyle a video", pick: ["v2v_seedance_2.5", "video2video_flux_3_edit"] },
    { task: "video: extend or upscale a video", pick: ["video2video_flux_3", "v2v_topaz_labs_video_upscale_astra"] },
    { task: "video: remove background, erase objects", pick: ["v2v_video_veed_background_removal", "v2v_bria_erase_prompt"] },
    { task: "audio: voiceover, text to speech", pick: ["t2a_elevenlabs_tts_multilingual_v2", "t2a_gemini_38_flash_tts"] },
    { task: "audio: dialogue, or a cloned voice", pick: ["t2a_elevenlabs_text-to-dialogue_eleven-v3_api", "ref2audio_seed_audio_1"] },
    { task: "audio: song or soundtrack", pick: ["t2a_suno_create_music"] },
    { task: "audio: sound effects or loops", pick: ["t2a_elevenlabs_sounds", "t2a_suno_create_sound"] },
    { task: "text: copy, translation, narrative", pick: ["Loremax_Text_Scene_Builder_v1"] },
  ],
};
