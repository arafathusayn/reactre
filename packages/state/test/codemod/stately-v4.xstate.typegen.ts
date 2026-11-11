// The typegen file XState v4's VS Code extension writes beside ./stately-v4.xstate.ts, which that
// export's `tsTypes` names. The converted machine no longer reads it.

export interface Typegen0 {
  "@@xstate/typegen": true;
  internalEvents: {
    "done.invoke.uploadFile": {
      type: "done.invoke.uploadFile";
      data: unknown;
      __tip: "See the XState TS docs to learn how to strongly type this.";
    };
    "error.platform.uploadFile": { type: "error.platform.uploadFile"; data: unknown };
    "xstate.init": { type: "xstate.init" };
  };
  invokeSrcNameMap: { uploadFile: "done.invoke.uploadFile" };
  missingImplementations: { actions: never; delays: never; guards: never; services: never };
  eventsCausingActions: { notifyUploaded: "done.invoke.uploadFile" };
  eventsCausingDelays: {};
  eventsCausingGuards: { isAllowedType: "PICK" };
  eventsCausingServices: { uploadFile: "PICK" | "RETRY" };
  matchesStates: "Done" | "Empty" | "Failed" | "Rejected" | "Uploading";
  tags: never;
}
