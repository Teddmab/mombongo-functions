import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();
export { admin, functions };
