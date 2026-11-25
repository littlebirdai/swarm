export type ModelState = Record<
  string,
  string | number | boolean | Record<string, number>
>;

type Case = readonly [
  name: string,
  config: string,
  actions: string,
  end?: ModelState,
];

export const traceCases = {
  Lease: [
    ["complete", "lease", "Claim Complete Finished"],
    [
      "give-back",
      "lease",
      "Claim GiveBack Claim GiveBack Claim GiveBack OutOfTokens",
    ],
    [
      "silent-holder",
      "lease",
      "Claim LeaseRunsOut Claim Complete",
      { item: "held" },
    ],
    ["late-renew", "lease", "Claim LeaseRunsOut Renew"],
    [
      "stale-completion",
      "lease",
      "Claim LeaseRunsOut Claim Complete Complete Finished",
      { done: 1 },
    ],
  ],
  Delivery: [
    [
      "own-retry",
      "delivery-own",
      "Claim Start Apply DaemonRestarts Apply Ack Done",
      { got: 1 },
    ],
    ["return-unstarted", "delivery-own", "Claim DaemonRestarts Requeue"],
    ["successor-unstarted", "delivery-own", "Claim HostDies Reopen Supersede"],
    [
      "successor-with-receipt",
      "delivery-own",
      "Claim Start Apply HostDies Reopen Supersede Done",
    ],
    [
      "successor-without-receipt",
      "delivery-own",
      "Claim Start HostDies Reopen Supersede",
      { st: "waiting" },
    ],
    [
      "paste-correlate",
      "delivery-paste",
      "Claim Start Apply DaemonRestarts ReportAmbiguous Correlate Done",
    ],
    [
      "paste-resend",
      "delivery-paste",
      "Claim Start Apply DaemonRestarts ReportAmbiguous SendAgain Claim Start Apply Ack Done",
      { got: 2 },
    ],
    [
      "paste-successor",
      "delivery-paste",
      "Claim Start HostDies Reopen Supersede HostDies Parked",
    ],
  ],
} satisfies Record<string, Case[]>;
