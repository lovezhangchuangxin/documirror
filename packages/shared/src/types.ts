export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type CommandProfileStep = {
  label: string;
  durationMs: number;
};

export type CommandProfile = {
  totalDurationMs: number;
  steps: CommandProfileStep[];
};
