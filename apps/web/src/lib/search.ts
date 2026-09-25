// Route search params (TanStack Router): typed or shared URLs are JSON-parsed, so `?new=4792024000222`
// or `?month=2026` can arrive as numbers. Accept both and turn them into text (decisions 2026-09-24).
import { z } from 'zod';

export const textParam = (max: number) => z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(max));

/** 'YYYY-MM' that may have been parsed as something else. */
export const monthParam = () => textParam(7).pipe(z.string().regex(/^\d{4}-\d{2}$/));

/** A uuid, or the literal 'none' (no category / shop). */
export const idParam = () => textParam(36).pipe(z.string().regex(/^([0-9a-f-]{36}|none)$/));
