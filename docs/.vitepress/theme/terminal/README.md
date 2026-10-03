# Void terminal demos

`TerminalDemos.vue` is the shared Vue component used by `Home.vue` and the `/terminal-demos` recording page. `TerminalPlayer.vue` can also play one `TerminalDemo` directly. The player uses a single animation clock, pauses offscreen or in a hidden tab, and shows a static final frame for reduced motion. Explicit Play still allows a visitor to run a demo.

The studio includes pause, replay, scrubbing, a final-frame button, 0.75×–2× speed, and an optional cycle through all three flows. Clean capture hides the controls and starts the selected demo after three seconds. Use CleanShot's area recording on the terminal. `R` replays with the same lead-in, `Space` pauses/resumes, and `Esc` exits clean capture. Controls are outside the recording area.

Links preserve `?demo=deploy|install|recover&speed=1|1.5|2|0.75`. Add `&capture=1` to open just the terminal. The demos are local scripted output; they make no CLI calls and require no Cloudflare credentials.

`demos.ts` contains sample values and shortened timings. These are representative, condensed workflows, not claims about actual deployment speed. Installation assumes Cloudflare login, PostgreSQL, OAuth, and credentials were prepared; recovery assumes a linked Void platform project with compatible migration state. Sample `.example` domains and deployment IDs are fictional.

When updating transcripts, compare wording and phases to:

- `packages/void/src/cli/deploy.ts`: `runFullDeploy`, `applyDeployEvent`, and the final note.
- `packages/void/src/cli/platform-lifecycle.ts`: install prompts and completion.
- `packages/void/src/cli/platform-installer.ts`: progress messages.
- `packages/void/src/cli/logs.ts` and `rollback.ts`: request formatting and rollback prompts.
- `packages/prompts`: the shared Vite+ glyphs, spinner, colors, and boxes.

Keep transient spinner updates on the same line ID and remove prompt options after selection. Do not invent resource guarantees or hide required credentials in the surrounding explanatory copy. The deploy sample targets an already connected Void platform; it is not a direct Cloudflare deployment.

Verify with `node --test docs/.vitepress/theme/terminal/timeline.test.ts`, `vp run build:docs`, and browser playback of all three flows. The unit tests cover pause/speed continuity, replay, backward seeking, Unicode typing, and aligned box edges. No framework or terminal-emulator dependency is added to the website.
