// During a Twitch picture-by-picture ad, the live stream keeps playing in a small
// window next to chat while the ad takes over the main player. Swap them: mute the
// ad, blow the small one up over the player, unmute it. Revert when the ad ends.

const PBYP_HOST = '.picture-by-picture-player';
const MAIN = '.video-player__container video';
const store = globalThis.browser?.storage?.local;  // absent outside the extension

const log = msg => console.log('[adswap] ' + msg);

log('loaded ' + (globalThis.browser?.runtime?.getManifest().version ?? 'dev'));

let active = null;
let suppressed = false;              // "Back to ad" was pressed; stay off until it ends
let lastVolume = null;               // carried across ads, and across reloads

store?.get('volume').then(r => { if (typeof r.volume === 'number') lastVolume = r.volume; });

function makeUi() {
  const ui = document.createElement('div');
  ui.dataset.adswap = '1';
  ui.style.cssText = 'position:fixed;z-index:10000;display:flex;align-items:center;gap:10px;' +
    'padding:6px 6px 6px 12px;border-radius:6px;background:rgba(0,0,0,.72);' +
    'font:600 12px/1 system-ui,sans-serif;color:#fff';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Back to ad';
  btn.style.cssText = 'border:0;border-radius:4px;padding:6px 10px;cursor:pointer;' +
    'font:inherit;color:#fff;background:#5b3ea8';
  btn.addEventListener('click', () => { if (active) { suppressed = true; stop('button'); } });
  ui.append('Stream swapped', btn);
  return ui;
}

// Geometry is re-read rather than baked in at swap time, so resizing, scrolling,
// theatre mode and fullscreen all keep the overlay on top of the player.
function place() {
  if (!active) return;
  const { stream, ui, ad } = active;
  // A fullscreen element renders in the top layer and hides everything outside its
  // subtree, so the overlay has to live inside it or it simply won't be visible.
  const fs = document.fullscreenElement;
  if (fs === stream) return;         // the overlay itself is fullscreen; leave it be
  const root = fs || document.body;
  if (stream.parentElement !== root) root.append(stream, ui);
  const box = fs
    ? { left: 0, top: 0, width: innerWidth, height: innerHeight }
    : ad.getBoundingClientRect();
  Object.assign(stream.style, {
    left: `${box.left}px`, top: `${box.top}px`,
    width: `${box.width}px`, height: `${box.height}px`,
  });
  Object.assign(ui.style, { left: `${box.left + 12}px`, top: `${box.top + 12}px` });
}

function start(stream, ad) {
  active = { ad, stream, ui: makeUi(), adMuted: ad.muted, stalled: 0, at: stream.currentTime };
  log('ad detected, swapping');
  stream.dataset.adswap = '1';       // so a leftover can always be found and killed
  ad.muted = true;
  stream.style.cssText += ';position:fixed;z-index:9999;background:#000';
  stream.controls = true;            // native play/pause/fullscreen
  // Firefox's native volume slider refuses to expand on this element, so scroll
  // over the video adjusts volume instead. preventDefault stops the page scrolling.
  stream.addEventListener('wheel', e => {
    e.preventDefault();
    stream.volume = Math.min(1, Math.max(0, stream.volume - Math.sign(e.deltaY) * 0.05));
  }, { passive: false });
  // Pausing from the controls must not read as "ad over". Transient activation is
  // still live inside the click handler, which is what separates it from a dead feed.
  stream.addEventListener('pause', () => {
    if (active) active.userPaused = navigator.userActivation.isActive;
  });
  stream.addEventListener('play', () => { if (active) active.userPaused = false; });
  // place() moves the element out of the chat column, whose transform would
  // otherwise trap position:fixed. Playback survives: the spec's pause-on-removal
  // check runs at the next stable state, by which time it is back in the document.
  place();
  stream.muted = false;
  stream.volume = lastVolume ?? (ad.volume || 0.5);
}

function stop(why) {
  const { ad, stream, ui, adMuted } = active;
  active = null;
  log('reverting: ' + why);
  lastVolume = stream.volume;
  store?.set({ volume: lastVolume });
  ad.muted = adMuted;
  // Never put the hijacked element back — React owns that subtree and builds its own.
  stream.remove();                   // removal pauses it; no explicit pause needed
  ui.remove();
}

addEventListener('resize', place);
document.addEventListener('scroll', place, true);   // Twitch scrolls an inner element
document.addEventListener('fullscreenchange', place);

setInterval(() => {
  if (active) {
    const { stream } = active;
    if (active.userPaused) return;   // you paused it on purpose; leave it alone
    // The feed dying is what ends a PbP ad in practice. The host check is the
    // backstop for the ad ending while the feed keeps running.
    if (stream.paused || stream.ended) return stop('stream stopped');
    if (!document.querySelector(PBYP_HOST)) return stop('host gone');
    // A feed can end without pausing: tracks stop, currentTime just freezes.
    active.stalled = stream.currentTime === active.at ? active.stalled + 1 : 0;
    active.at = stream.currentTime;
    if (active.stalled >= 3) return stop('stream stalled 3s');
    return;
  }
  if (!document.querySelector(PBYP_HOST)) suppressed = false;   // ad is over
  // Safety net: a tagged leftover while not active is a revert that never ran.
  // Without this, a dead full-size video sits over the player until you refresh.
  document.querySelectorAll('[data-adswap]').forEach(el => {
    log('sweeping orphaned overlay');
    el.remove();
  });
  if (suppressed) return;
  const stream = document.querySelector(`${PBYP_HOST} video`), ad = document.querySelector(MAIN);
  if (stream && ad && !stream.paused && stream.videoWidth) start(stream, ad);
}, 1000);
