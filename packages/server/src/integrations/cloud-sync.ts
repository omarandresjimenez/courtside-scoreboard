import admin from 'firebase-admin';
import { v2 as cloudinary } from 'cloudinary';

let db: any;
let isInitialized = false;

/**
 * Initialize Firebase Admin SDK
 */
export function initializeCloudServices() {
  if (isInitialized) return;

  try {
    // Only initialize if credentials are available
    if (
      !process.env.FIREBASE_PROJECT_ID ||
      !process.env.FIREBASE_PRIVATE_KEY
    ) {
      console.warn(
        '[Cloud] Firebase credentials not found - cloud sync disabled'
      );
      isInitialized = false;
      return;
    }

    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      clientId: process.env.FIREBASE_CLIENT_ID,
      authUri: 'https://accounts.google.com/o/oauth2/auth',
      tokenUri: 'https://oauth2.googleapis.com/token',
      authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
    };

    (admin as any).initializeApp({
      credential: (admin as any).credential.cert(serviceAccount),
    });

    db = (admin as any).firestore();
    isInitialized = true;
    console.log('[Cloud] Firebase initialized');
  } catch (error) {
    console.error('[Cloud] Firebase initialization failed:', error);
    isInitialized = false;
  }

  // Initialize Cloudinary
  if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    console.log('[Cloud] Cloudinary configured');
  } else {
    console.warn('[Cloud] Cloudinary credentials not found');
  }
}

/**
 * Sync score updates to Firestore
 */
export async function syncScoreToCloud(
  courtId: string,
  matchData: any
): Promise<boolean> {
  if (!isInitialized || !db) {
    console.debug('[Cloud] Cloud sync not initialized, skipping');
    return false;
  }

  try {
    await db.collection('matches').doc(courtId).set(
      {
        ...matchData,
        updatedAt: new Date(),
        syncStatus: 'synced',
      },
      { merge: true }
    );

    console.log(`[Cloud] Score synced for court ${courtId}`);
    return true;
  } catch (error) {
    console.error(`[Cloud] Sync failed for court ${courtId}:`, error);
    return false;
  }
}

/**
 * Upload video frame to Cloudinary
 */
export async function uploadFrameToCloud(
  courtId: string,
  jpegBuffer: Buffer
): Promise<string | null> {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY
  ) {
    console.debug('[Cloud] Cloudinary not configured, skipping upload');
    return null;
  }

  try {
    // Convert buffer to base64 data URI
    const dataUri = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder: `courtside/court-${courtId}`,
      public_id: `latest-frame`,
      overwrite: true,
      resource_type: 'image',
      quality: 'auto',
      fetch_format: 'auto',
    });

    console.log(`[Cloud] Frame uploaded: ${result.secure_url}`);
    return result.secure_url;
  } catch (error) {
    console.error('[Cloud] Frame upload failed:', error);
    return null;
  }
}

/**
 * Update Firestore with video frame URL
 */
export async function updateFrameUrl(
  courtId: string,
  frameUrl: string
): Promise<boolean> {
  if (!isInitialized || !db) {
    console.debug('[Cloud] Cloud sync not initialized, skipping');
    return false;
  }

  try {
    await db.collection('matches').doc(courtId).update({
      videoFrameUrl: frameUrl,
      videoFrameUpdatedAt: new Date(),
    });

    console.log(`[Cloud] Frame URL updated for court ${courtId}`);
    return true;
  } catch (error) {
    console.error('[Cloud] Frame URL update failed:', error);
    return false;
  }
}

export { db as firestore };
