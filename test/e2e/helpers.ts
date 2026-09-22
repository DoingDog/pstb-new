import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

type CreatePasteInput = {
  content: string;
  title: string;
  format: "text" | "markdown";
  expiration: "permanent";
  password: string;
  viewOnce: boolean;
  customId: string;
};

export function uniquePasteId(): string {
  return `e2e-${randomUUID()}`;
}

export async function createPaste(request: APIRequestContext, overrides: Partial<CreatePasteInput> = {}) {
  const customId = overrides.customId ?? uniquePasteId();
  const input: CreatePasteInput = {
    content: "e2e content",
    title: "",
    format: "text",
    expiration: "permanent",
    password: "",
    viewOnce: false,
    ...overrides,
    customId,
  };
  const response = await request.post("/api/pastes", { data: input });
  expect(response.status()).toBe(201);
  return { id: customId, password: input.password };
}
