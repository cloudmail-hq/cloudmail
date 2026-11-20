// Email Templates Service - Stored in R2
// Templates are shared across all mailboxes

// R2Bucket is an ambient global from the generated worker-configuration.d.ts.
// Do not import it from @cloudflare/workers-types - the two declarations are
// structurally incompatible and every call site fails to typecheck.

import { listJsonUnderPrefix } from "./r2";

export interface EmailTemplate {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  createdAt: number;
  updatedAt: number;
}

const TEMPLATES_PREFIX = "templates/";

function templateKey(slug: string): string {
  return `${TEMPLATES_PREFIX}${slug}.json`;
}

export async function listTemplates(bucket: R2Bucket): Promise<EmailTemplate[]> {
  const templates = await listJsonUnderPrefix<EmailTemplate>(
    bucket,
    TEMPLATES_PREFIX
  );

  // Sort by updatedAt descending
  return templates.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getTemplate(
  bucket: R2Bucket,
  slug: string
): Promise<EmailTemplate | null> {
  const obj = await bucket.get(templateKey(slug));
  if (!obj) return null;
  return obj.json<EmailTemplate>();
}

export async function createTemplate(
  bucket: R2Bucket,
  data: { slug: string; name: string; subject: string; bodyHtml: string }
): Promise<EmailTemplate> {
  const { slug, name, subject, bodyHtml } = data;
  
  // Check if slug already exists
  const existing = await bucket.head(templateKey(slug));
  if (existing) {
    throw new Error("Template with this slug already exists");
  }
  
  const now = Math.floor(Date.now() / 1000);
  const template: EmailTemplate = {
    id: crypto.randomUUID(),
    slug,
    name,
    subject,
    bodyHtml,
    createdAt: now,
    updatedAt: now,
  };
  
  await bucket.put(templateKey(slug), JSON.stringify(template));
  return template;
}

export async function updateTemplate(
  bucket: R2Bucket,
  slug: string,
  data: { name?: string; subject?: string; bodyHtml?: string }
): Promise<EmailTemplate | null> {
  const existing = await getTemplate(bucket, slug);
  if (!existing) return null;
  
  const updated: EmailTemplate = {
    ...existing,
    ...(data.name !== undefined && { name: data.name }),
    ...(data.subject !== undefined && { subject: data.subject }),
    ...(data.bodyHtml !== undefined && { bodyHtml: data.bodyHtml }),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  
  await bucket.put(templateKey(slug), JSON.stringify(updated));
  return updated;
}

export async function deleteTemplate(
  bucket: R2Bucket,
  slug: string
): Promise<boolean> {
  const existing = await bucket.head(templateKey(slug));
  if (!existing) return false;
  
  await bucket.delete(templateKey(slug));
  return true;
}

// Variable extraction from template content
const VARIABLE_REGEX = /\{\{(\w+)\}\}/g;

export function extractVariables(subject: string, bodyHtml: string): string[] {
  const combined = `${subject} ${bodyHtml}`;
  const matches = combined.matchAll(VARIABLE_REGEX);
  const vars = new Set<string>();
  
  for (const match of matches) {
    vars.add(match[1]);
  }
  
  return Array.from(vars);
}

// Render template with variables
export function renderTemplate(
  template: EmailTemplate,
  variables: Record<string, string>
): { subject: string; bodyHtml: string } {
  const render = (text: string): string => {
    return text.replace(VARIABLE_REGEX, (match, varName) => {
      return variables[varName] ?? match;
    });
  };
  
  return {
    subject: render(template.subject),
    bodyHtml: render(template.bodyHtml),
  };
}
