import { ensurePGliteTemplateBundlePath } from "./db-template";

export default async function setup(): Promise<void> {
  await ensurePGliteTemplateBundlePath();
}
