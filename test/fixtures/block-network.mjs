// Invalid-input stdio tests must never contact a provider, even on regression.
import http from 'node:http';
import https from 'node:https';
const blocked = () => { throw new Error('TEST_EXTERNAL_NETWORK_FORBIDDEN'); };
http.request = blocked;
https.request = blocked;
globalThis.fetch = blocked;
