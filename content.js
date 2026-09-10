// During a Twitch picture-by-picture ad, the live stream keeps playing in a small
// window next to chat while the ad takes over the main player. Swap them: mute the
// ad, blow the small one up over the player, unmute it. Revert when the ad ends.

const PBYP_HOST = '.picture-by-picture-player';
const MAIN = '.video-player__container video';

let active = null;
let lastVolume = null;               // carried across ads so you set it once

function start(stream, ad) {
  const box = ad.getBoundingClientRect();
  active = { ad, stream, adMuted: ad.muted, stalled: 0, at: stream.currentTime };
  console.log('[twitchpip] ad detected, swapping');
  stream.dataset.twitchpip = '1';     // so a leftover can always be found and killed
  ad.muted = true;
  // .channel-root__right-column has a transform, which makes it the containing block
  // for any position:fixed descendant. Reparent to <body> to escape it. Safe: the
  // spec's pause-on-removal check runs at the next stable state, and append() puts
  // the element back in the document within the same task.
  document.body.append(stream);
  stream.style.cssText += `;position:fixed;left:${box.left}px;top:${box.top}px;` +
    `width:${box.width}px;height:${box.height}px;z-index:9999;background:#000`;
  stream.controls = true;            // native play/pause/fullscreen
  // Firefox's native volume slider refuses to expand on this element, so scroll
  // over the video adjusts volume instead. preventDefault stops the page scrolling.
  stream.addEventListener('wheel', e => {
    e.preventDefault();
    stream.volume = Math.min(1, Math.max(0, stream.volume - Math.sign(e.deltaY) * 0.05));
  }, { passive: false });
  stream.muted = false;
  stream.volume = lastVolume ?? (ad.volume || 0.5);
  // Pausing from the controls must not read as "ad over". Transient activation is
  // still live inside the click handler, which is what separates it from a dead feed.
  stream.addEventListener('pause', () => {
    if (active) active.userPaused = navigator.userActivation.isActive;
  });
  stream.addEventListener('play', () => { if (active) active.userPaused = false; });
}

function stop(why) {
  const { ad, stream, adMuted } = active;
  active = null;
  console.log('[twitchpip] reverting:', why);
  lastVolume = stream.volume;
  ad.muted = adMuted;
  // Never put the hijacked element back — React owns that subtree and builds its own.
  stream.remove();                   // removal pauses it; no explicit pause needed
}

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
  // Safety net: a tagged overlay while not active is a revert that never ran.
  // Without this, a dead full-size video sits over the player until you refresh.
  document.querySelectorAll('video[data-twitchpip]').forEach(v => {
    console.warn('[twitchpip] sweeping orphaned overlay');
    v.remove();
  });
  const stream = document.querySelector(`${PBYP_HOST} video`), ad = document.querySelector(MAIN);
  if (stream && ad && !stream.paused && stream.videoWidth) start(stream, ad);
}, 1000);
