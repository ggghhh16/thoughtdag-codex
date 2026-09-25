import GenerationInteractionDialog from './components/ui/GenerationInteractionDialog';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import App from './App'
import TextbookReader from './components/TextbookReader'
import { bootTextbookHost } from './lib/textbook-host'
const isTextbook = new URLSearchParams(window.location.search).has('textbook')
import { bootProjects } from './store/projects'
import { isViewerMode, bootViewer } from './lib/viewer'
import { initAppearance } from './lib/appearance'
import { migrateDesktopLegacyStorage } from './lib/desktop-storage-migration'

// Theme attributes land on <html> before first paint — no wrong-theme flash
initAppearance()

// Resolve the active project and rehydrate the store before/while React
// mounts — App's hydration gate opens when this finishes. A #view= link
// boots read-only instead: graph from the URL, persistence silenced.
async function bootAuthorMode(): Promise<void> {
  // Desktop releases before the origin was fixed could store a second set of
  // canvases under :31174. Merge it before the project store chooses and
  // hydrates an active canvas.
  await migrateDesktopLegacyStorage()
  await bootProjects()
  bootTextbookHost()
  // Ask the browser to mark this origin's storage persistent — exempts the
  // IndexedDB canvases from best-effort eviction under disk pressure.
  // Browsers grant it silently based on engagement; a refusal is harmless.
  if (navigator.storage?.persist) void navigator.storage.persist()
  void import('./lib/local-backup').then((m) => m.bootAutoBackup())
}

if (isTextbook) { /* Reader is a command-only client: never hydrate or persist the graph. */ }
else if (isViewerMode) void bootViewer()
else void bootAuthorMode()

// A long-lived tab keeps running the bundle it loaded; nudge when a newer
// deploy lands (viewer tabs included — a shared link can sit open for days).
void import('./lib/update-check').then((m) => m.bootUpdateCheck())

// Pasting a #view= link into an ALREADY-OPEN tab only changes the hash —
// the browser won't reload, so the viewer/author decision above never
// re-runs. Cross the boundary with an explicit reload (both directions).
window.addEventListener('hashchange', () => {
  if (window.location.hash.startsWith('#view=') !== isViewerMode) window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isTextbook ? <TextbookReader /> : <><App /><GenerationInteractionDialog /></>}
  </StrictMode>,
)
