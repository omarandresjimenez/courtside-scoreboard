import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

/**
 * WebRTC signalling over Firestore, for viewers watching from the internet.
 *
 * The LAN path (see webrtc-stream.ts) signals over Socket.io against the
 * desktop app, which nobody outside the venue can reach. This is the second
 * path: the phone and an internet viewer both have internet, so they can
 * exchange SDP through Firestore and then connect peer-to-peer directly. No
 * port forwarding, and the laptop is never exposed.
 *
 * Both paths run at once rather than replacing the LAN one, because the LAN
 * path is the only one that still works when venue wifi has no uplink — which
 * is exactly the situation this app is built to survive.
 *
 * Document layout (one entry per viewer, since WebRTC is a mesh here):
 *
 *   streams/{courtId}                       { live, updatedAt }
 *   streams/{courtId}/viewers/{viewerId}    { offer?, answer? }
 *   streams/{courtId}/viewers/{viewerId}/offerCandidates/*   (broadcaster ICE)
 *   streams/{courtId}/viewers/{viewerId}/answerCandidates/*  (viewer ICE)
 */

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Hard cap on internet peers. Each one costs the phone a *separate* encoded
 * upload (WebRTC mesh), so an uncapped count would saturate a phone uplink and
 * degrade the picture for everyone — including the LAN viewers. Also the
 * practical mitigation for the open signalling rules: a stranger who finds the
 * court id still cannot make the phone fan out indefinitely.
 */
export const MAX_INTERNET_VIEWERS = 5;

/**
 * How old an unanswered viewer request may be before it is treated as
 * abandoned. A viewer doc is only removed on `pagehide`, which does not fire
 * on a crash, a force-quit, a phone evicting a background tab, or a network
 * drop — so without this, every such viewer leaves a corpse that permanently
 * consumes one of the MAX_INTERNET_VIEWERS slots, and eventually the
 * broadcaster refuses every real viewer. Observed for real: ten stale docs,
 * the oldest over three hours, blocking all new connections.
 */
const VIEWER_REQUEST_TTL_MS = 60_000;

/**
 * A peer that never reaches `connected` is presumed gone. Frees the slot
 * rather than holding it against a viewer that will never arrive.
 */
const CONNECT_TIMEOUT_MS = 30_000;

export interface FirestoreSignalConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

function appFor(config: FirestoreSignalConfig): FirebaseApp {
  // Reuse the default app if something else already initialised it, rather
  // than throwing on a duplicate.
  return getApps()[0] ?? initializeApp(config);
}

export interface InternetBroadcastHandle {
  stop: () => void;
  viewerCount: () => number;
  setPaused: (paused: boolean) => void;
}

/**
 * Everything a single viewer owns, so it can all be released together.
 *
 * `release` exists because the per-viewer Firestore listeners used to be
 * fire-and-forget: `onSnapshot` returns an unsubscribe function, and both of
 * the ones below were being discarded. Closing the peer connection does not
 * detach a Firestore listener, so every viewer that came and went left two
 * live snapshot listeners behind for the lifetime of the broadcast — each one
 * still billing reads against a document nobody was watching any more.
 */
interface PeerSession {
  pc: RTCPeerConnection;
  release: () => void;
}

/**
 * Publish `stream` to any internet viewer that asks for it via Firestore.
 * Returns immediately; connections are established as viewers appear.
 */
export function broadcastToInternet(
  config: FirestoreSignalConfig,
  courtId: string,
  stream: MediaStream,
  onCountChange?: (count: number) => void,
): InternetBroadcastHandle {
  const db: Firestore = getFirestore(appFor(config));
  const streamDoc = doc(db, 'streams', courtId);
  const viewersCol = collection(db, 'streams', courtId, 'viewers');
  const peers = new Map<string, PeerSession>();
  let stopped = false;

  // `paused` is reset on both start and stop so a broadcast never inherits a
  // stale paused flag from a previous session on this court — the same reason
  // the Socket.io path clears pausedByCourtId when a broadcaster connects.
  const announce = (live: boolean) =>
    setDoc(streamDoc, { live, paused: false, updatedAt: serverTimestamp() }, { merge: true }).catch(
      () => {
        // Presence is a convenience for the viewer's placeholder text, not a
        // correctness requirement — a failure here must not stop the broadcast.
      },
    );
  void announce(true);

  function report() {
    onCountChange?.(peers.size);
  }

  /**
   * Close a peer and detach every listener and timer it owns, without
   * touching Firestore. Safe to call for an unknown id.
   */
  function releasePeer(viewerId: string): void {
    const session = peers.get(viewerId);
    if (!session) return;
    session.release();
    session.pc.close();
    peers.delete(viewerId);
    report();
  }

  /** Release a peer and also clear its signalling doc, freeing the slot it held. */
  function dropViewer(viewerId: string): void {
    releasePeer(viewerId);
    void deleteDoc(doc(viewersCol, viewerId)).catch(() => {});
  }

  async function connectViewer(viewerId: string, requestedAt?: number): Promise<void> {
    if (stopped || peers.has(viewerId)) return;

    // Abandoned request from a viewer that never came back (see
    // VIEWER_REQUEST_TTL_MS). Clear it instead of spending a slot on it.
    if (typeof requestedAt === 'number' && Date.now() - requestedAt > VIEWER_REQUEST_TTL_MS) {
      void deleteDoc(doc(viewersCol, viewerId)).catch(() => {});
      return;
    }
    if (peers.size >= MAX_INTERNET_VIEWERS) return;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Collected as they are created, so a viewer's teardown is one call and
    // cannot silently miss a listener added later.
    const teardown: Array<() => void> = [];
    peers.set(viewerId, {
      pc,
      release: () => {
        teardown.forEach((detach) => detach());
        teardown.length = 0;
      },
    });
    report();

    const connectTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') dropViewer(viewerId);
    }, CONNECT_TIMEOUT_MS);
    teardown.push(() => clearTimeout(connectTimer));

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    const viewerDoc = doc(viewersCol, viewerId);
    const offerCandidates = collection(viewerDoc, 'offerCandidates');
    const answerCandidates = collection(viewerDoc, 'answerCandidates');

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void addDoc(offerCandidates, event.candidate.toJSON()).catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed' ||
        pc.connectionState === 'disconnected'
      ) {
        dropViewer(viewerId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setDoc(viewerDoc, { offer: { type: offer.type, sdp: offer.sdp } }, { merge: true });

    // stop() can land during any of the awaits above. Registering listeners
    // after that point would attach them to a session nothing will ever tear
    // down again — the leak this whole structure exists to prevent.
    if (stopped || !peers.has(viewerId)) {
      releasePeer(viewerId);
      return;
    }

    // The viewer's answer, then its ICE. Both arrive asynchronously.
    teardown.push(
      onSnapshot(viewerDoc, (snap) => {
        const answer = snap.data()?.answer;
        if (answer && !pc.currentRemoteDescription) {
          void pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(() => {});
        }
      }),
    );

    teardown.push(
      onSnapshot(answerCandidates, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type !== 'added') return;
          void pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {
            // Candidates routinely lose the race against a closing connection.
          });
        });
      }),
    );
  }

  // Anything already in this collection predates the broadcast that is only
  // just starting, so by definition it is a leftover from a previous session.
  // Clearing it up-front means a new broadcast never begins with its viewer
  // slots already spent on peers that no longer exist.
  const purged = getDocs(viewersCol)
    .then((snap) => Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {}))))
    .catch(() => {});

  // Viewers announce themselves by creating their own document.
  let unsubscribeViewers: () => void = () => {};
  void purged.then(() => {
    if (stopped) return;
    unsubscribeViewers = onSnapshot(viewersCol, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'added') {
          void connectViewer(change.doc.id, change.doc.data()?.requestedAt as number | undefined);
        }
        if (change.type === 'removed') {
          releasePeer(change.doc.id);
        }
      });
    });
  });

  return {
    stop() {
      stopped = true;
      unsubscribeViewers();
      // release() before close() so the pending connect timer cannot fire
      // after teardown and call back into onCountChange — which, on the
      // broadcast screen, is a React setState on an unmounted component.
      peers.forEach((session) => {
        session.release();
        session.pc.close();
      });
      peers.clear();
      report();
      void announce(false);
      // Leave the collection clean for the next broadcast. Best-effort: the
      // start-up purge above is what actually guarantees a clean slate, since
      // this can be cut short by the tab closing.
      void getDocs(viewersCol)
        .then((snap) => snap.docs.forEach((d) => void deleteDoc(d.ref).catch(() => {})))
        .catch(() => {});
    },
    viewerCount: () => peers.size,

    /**
     * Tell internet viewers the camera is paused.
     *
     * Necessary for the same reason the LAN path emits STREAM_EVENTS.PAUSED:
     * disabling a video track keeps the peer connection up and simply sends
     * black frames, so a viewer sees a dead picture that is indistinguishable
     * from a broken connection on their own end. Carried in the stream
     * document rather than per-viewer, since it is one fact about the court
     * that every viewer needs.
     */
    setPaused(paused: boolean) {
      void setDoc(streamDoc, { paused, updatedAt: serverTimestamp() }, { merge: true }).catch(
        () => {
          // A dropped pause notice is cosmetic; never break the broadcast.
        },
      );
    },
  };
}
