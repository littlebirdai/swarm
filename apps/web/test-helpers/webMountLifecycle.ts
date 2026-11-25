type ActiveMount = {
  dispose: () => Promise<void>;
  close: () => Promise<void>;
};

export const webMountLifecycle: { active?: ActiveMount } = {};
