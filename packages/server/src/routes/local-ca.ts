import { Router } from 'express';
import { getOrCreateLocalTlsIdentity } from '../integrations/local-tls.js';

export const localCaRouter = Router();

// Public, unauthenticated, and deliberately serves only the CA's
// certificate — never its private key (see local-tls.ts). This is exactly
// what the file is for: a phone that has never seen the admin password
// still needs to be able to install it once to stop seeing the camera
// page's "not private" warning. The MIME type matters — it's what makes
// iOS Safari and Android Chrome offer to install this as a trusted
// certificate profile instead of just downloading or displaying the file.
localCaRouter.get('/local-ca.pem', async (_req, res) => {
  const { caCert } = await getOrCreateLocalTlsIdentity();
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="courtside-scoreboard-ca.pem"');
  res.send(caCert);
});
