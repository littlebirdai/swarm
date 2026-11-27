import { create } from "zustand";

type Contact = {
  viewer: string;
  machine: string;
  connection: string;
  sequence: number;
  deadline: number;
};

export const useInboxRelayLiveness = create<{
  visible: Record<string, number>;
  contacts: Record<string, Contact | undefined>;
}>(() => ({ visible: {}, contacts: {} }));

export function mountRelayInboxCard(id: string) {
  useInboxRelayLiveness.setState(({ visible }) => ({
    visible: { ...visible, [id]: (visible[id] ?? 0) + 1 },
  }));
  return () =>
    useInboxRelayLiveness.setState(({ visible }) => {
      const next = { ...visible };
      if (next[id] > 1) next[id]--;
      else delete next[id];
      return { visible: next };
    });
}

export function setInboxRelayContact(id: string, contact?: Contact) {
  useInboxRelayLiveness.setState((state) => {
    if (!contact && !state.contacts[id]) return state;
    const contacts = { ...state.contacts };
    if (contact) contacts[id] = contact;
    else delete contacts[id];
    return { contacts };
  });
}
