// PostHog product analytics, loaded first in the lobby (public/v2.html, top of <body>, after the splash) and by a game
// page opened on its own (dsTrack.js loads it).
// Events go through public/js/shared/dsTrack.js and the one plan in shared/trackPlan.js; this file only starts
// PostHog. The project token is a WRITE-ONLY public key, safe in client code. person_profiles 'identified_only':
// anonymous visitors still count for traffic and geography, and a signed-in wallet gets a person profile.
// Session replay masks every input and anything marked .ph-no-capture (wallet addresses, balances); JS errors are
// captured as exceptions.
//
// In a game frame inside the lobby (same origin) this does nothing: the frame sends through the lobby's PostHog
// (dsTrack.js), so a visit is one person, one session and one replay. The visit ping below is unchanged: a
// top-level page only, and not from a page that loads this with data-no-visit-ping (the lobby, and a game page
// opened on its own, as before this file was loaded there).
(function () {
var me = document.currentScript;
/* A Google sign-in comes back with a one-time privy_oauth_code (and state) in the address until the wallet widget
   clears it: never in an event, and no replay starts until it is gone. */
var OAUTH = /([?&])privy_oauth_[^=&#]*=[^&#]*&?/g;
function clean(u) { return typeof u === 'string' && u.indexOf('privy_oauth_') >= 0 ? u.replace(OAUTH, '$1').replace(/[?&]$/, '') : u; }
var URL_KEYS = ['$current_url', '$referrer', '$session_entry_url', '$initial_current_url', '$pathname', '$initial_referrer'];
function scrub(ev) {
  try {
    var bags = [ev && ev.properties, ev && ev.$set, ev && ev.$set_once, ev && ev.properties && ev.properties.$set, ev && ev.properties && ev.properties.$set_once];
    for (var i = 0; i < bags.length; i++) {
      var b = bags[i];
      if (!b) continue;
      for (var k = 0; k < URL_KEYS.length; k++) if (typeof b[URL_KEYS[k]] === 'string') b[URL_KEYS[k]] = clean(b[URL_KEYS[k]]);
    }
  } catch (e) { /* send it as is rather than not at all */ }
  return ev;
}
var oauthBack = String(location.search).indexOf('privy_oauth_') >= 0;
var framed = false;
try { framed = window.top !== window.self && window.top.location.origin === window.location.origin && !!window.top.posthog; } catch (e) { framed = false; }
if (framed) return;
!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="xi Si init Ni ji pr qi Ui $i capture calculateEventProperties Zi register register_once register_for_session unregister unregister_for_session Yi getFeatureFlag getFeatureFlagPayload getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Ki identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty Qi Wi createPersonProfile setInternalOrTestUser Ji Fi tn opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing zi debug mr it getPageViewId captureTraceFeedback captureTraceMetric Ri".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init('phc_rGiSHXN4HzBvzZaZhuFCwbmHFihkemTVcxK7MCPdDqgw', {
    api_host: window.location.origin + '/ingest', // reverse-proxied through our own domain (beats ad blockers)
    ui_host: 'https://us.posthog.com',
    defaults: '2026-05-30',
    person_profiles: 'identified_only',
    capture_exceptions: true,
    before_send: scrub,
    disable_session_recording: oauthBack,
    // Privy's sign-in and funding windows render in this page: their text (an email being confirmed) is masked too
    session_recording: { maskAllInputs: true, maskTextSelector: '.ph-no-capture, #privy-dialog, [id^="privy-"]' },
});
if (oauthBack) {
  var waited = 0;
  var t = setInterval(function () {
    waited += 500;
    if (String(location.search).indexOf('privy_oauth_') < 0) {
      clearInterval(t);
      try { if (window.posthog && window.posthog.startSessionRecording) window.posthog.startSessionRecording(); } catch (e) {}
    } else if (waited >= 30000) clearInterval(t);
  }, 500);
}

// The older call sites; dsTrack.js replaces both with versions that check the plan.
window.phEvent = function (name, props) {
  try { if (window.posthog && window.posthog.capture) window.posthog.capture(name, props || {}); } catch (e) {}
};
window.phIdentify = function (id, props) {
  try { if (id && window.posthog && window.posthog.identify) window.posthog.identify(String(id), props || {}); } catch (e) {}
};

// Tell the server someone opened the site so it can ping the owner's phone. Top-level page only
// (window.self === window.top) so the in-game iframes don't double-count a single site visit.
try {
  if (window.self === window.top && !(me && me.hasAttribute && me.hasAttribute('data-no-visit-ping'))) {
    fetch('/api/track/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: location.pathname, ref: document.referrer || '' }),
      keepalive: true,
    }).catch(function () {});
  }
} catch (e) {}
})();
