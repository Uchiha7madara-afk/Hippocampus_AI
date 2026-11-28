import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json';

function initFirebaseAdminApp() {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() || firebaseConfig.projectId;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();

  if (serviceAccountJson) {
    const parsed = JSON.parse(serviceAccountJson);
    return initializeApp({
      credential: cert(parsed),
      projectId: parsed.project_id || projectId,
    });
  }

  return initializeApp({
    projectId,
  });
}

initFirebaseAdminApp();

export const adminAuth = getAuth();
