import { db, admin, functions } from "../lib/admin";

/**
 * Persiste une action utilisateur (formulaires marché / bourse / financement)
 * en attendant des CF métier dédiées.
 */
export const submitUserAction = functions
  .region("europe-west1")
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid;
    if (!uid) throw new functions.https.HttpsError("unauthenticated", "Login required");

    const { actionType, payload } = data as {
      actionType?: string;
      payload?: Record<string, unknown>;
    };

    if (!actionType || typeof actionType !== "string") {
      throw new functions.https.HttpsError("invalid-argument", "actionType required");
    }

    const ref = db.collection("user_actions").doc();
    await ref.set({
      id: ref.id,
      userId: uid,
      actionType,
      payload: payload ?? {},
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, actionId: ref.id };
  });
