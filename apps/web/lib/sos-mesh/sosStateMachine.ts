/**
 * Offline SOS Mesh — Emergency SOS State Machine
 * 
 * Formal state machine managing the lifecycle of an emergency SOS dispatch
 * from initial button trigger down to store-and-forward relay and gateway delivery.
 */

type SOSState =
  | 'IDLE'
  | 'SOS_TRIGGERED'
  | 'PACKET_CREATED'
  | 'LOCAL_PERSISTED'
  | 'TRY_INTERNET'
  | 'TRY_PEER_MESH'
  | 'TRY_BLE_RELAY'
  | 'RELAYED'
  | 'DELIVERED'
  | 'NO_NETWORK'
  | 'NO_RELAY'
  | 'EXPIRED'
  | 'DELIVERY_FAILED'
  | 'CANCELLED';

/** Mirrors TransportChannel; kept local so the state machine stays dependency-free. */
type SOSTransportLabel = 'INTERNET' | 'PEER_MESH' | 'BLE_RELAY' | 'LOCAL_QUEUE';

interface SOSStateChangeEvent {
  previousState: SOSState;
  currentState: SOSState;
  timestamp: number;
  message?: string;
  incidentId?: string;
  transport?: SOSTransportLabel;
  hopCount?: number;
}

type SOSStateListener = (event: SOSStateChangeEvent) => void;

export class SOSStateMachine {
  private state: SOSState = 'IDLE';
  private listeners: Set<SOSStateListener> = new Set();
  private lastEvent?: SOSStateChangeEvent;

  constructor(initialState: SOSState = 'IDLE') {
    this.state = initialState;
  }

  public getState(): SOSState {
    return this.state;
  }

  public getLastEvent(): SOSStateChangeEvent | undefined {
    return this.lastEvent;
  }

  public transitionTo(
    nextState: SOSState,
    meta?: {
      message?: string;
      incidentId?: string;
      transport?: SOSTransportLabel;
      hopCount?: number;
    }
  ): SOSStateChangeEvent {
    const previousState = this.state;
    this.state = nextState;

    const event: SOSStateChangeEvent = {
      previousState,
      currentState: nextState,
      timestamp: Date.now(),
      message: meta?.message,
      incidentId: meta?.incidentId,
      transport: meta?.transport,
      hopCount: meta?.hopCount,
    };

    this.lastEvent = event;
    this.notify(event);
    return event;
  }

  public subscribe(listener: SOSStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: SOSStateChangeEvent) {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        console.error('[SOSStateMachine] Listener error:', err);
      }
    });
  }

  public reset() {
    this.transitionTo('IDLE', { message: 'State machine reset to IDLE.' });
  }
}

/** Global singleton instance for app-wide state monitoring */
export const globalSOSStateMachine = new SOSStateMachine();
