import type { PasteResource } from "../types";

export type {
  AppBootstrap,
  ErrorCode,
  ExpirationInput,
  HistoryList,
  MutationResult,
  PasteSummary,
  RevisionResource,
} from "../types";

export type RemoteSnapshot = PasteResource;

export interface BaselineCapture {
  acceptedApplyGeneration: number;
  localGeneration: number;
  generation: string | "legacy";
  version: string;
  contentRevision: number;
  updatedAt: string;
  acceptedSource: string;
}
