// PostHog product analytics — loaded in the <head> of the lobby + both game iframes so the whole
// player journey is tracked (visits, logins, stakes, cash-outs) plus automatic geography (where
// players are, for ad targeting). The project token is a WRITE-ONLY public key — safe in client
// code. person_profiles:'identified_only' means anonymous visitors still count for traffic/geo,
// but only logged-in wallets (we call posthog.identify(wallet)) get a persistent person profile.
// session_recording maskAllInputs + the .ph-no-capture class keep wallet addresses/balances out
// of replays.
!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="xi Si init Ni ji pr qi Ui $i capture calculateEventProperties Zi register register_once register_for_session unregister unregister_for_session Yi getFeatureFlag getFeatureFlagPayload getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync Ki identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty Qi Wi createPersonProfile setInternalOrTestUser Ji Fi tn opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing zi debug mr it getPageViewId captureTraceFeedback captureTraceMetric Ri".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init('phc_rGiSHXN4HzBvzZaZhuFCwbmHFihkemTVcxK7MCPdDqgw', {
    api_host: 'https://us.i.posthog.com',
    defaults: '2026-05-30',
    person_profiles: 'identified_only',
    session_recording: { maskAllInputs: true, maskTextSelector: '.ph-no-capture' },
});

// Small safe wrapper so the rest of the app can fire events without worrying whether PostHog has
// loaded yet (the stub above queues calls until it does). Usage: window.phEvent('staked', {...}).
window.phEvent = function (name, props) {
  try { if (window.posthog && window.posthog.capture) window.posthog.capture(name, props || {}); } catch (e) {}
};
window.phIdentify = function (id, props) {
  try { if (id && window.posthog && window.posthog.identify) window.posthog.identify(String(id), props || {}); } catch (e) {}
};
