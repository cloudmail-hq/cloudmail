// Template Editor Page
import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { ArrowLeft, Save, Loader2 } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import TemplateBodyEditor from "~/components/templates/TemplateBodyEditor";
import { extractVariables } from "~/lib/template-preview";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import api from "~/services/api";
import { PageContainer } from "~/components/ui/page";

interface Template {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  createdAt: number;
  updatedAt: number;
}

export default function TemplateEditorPage() {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const isNew = !slug || slug === "new";

  const [name, setName] = useState("");
  const [templateSlug, setTemplateSlug] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isNew && slug) {
      fetchTemplate(slug);
    }
  }, [isNew, slug]);

  async function fetchTemplate(templateSlug: string) {
    try {
      setLoading(true);
      const template = await api.getTemplate(templateSlug);
      setName(template.name);
      setTemplateSlug(template.slug);
      setSubject(template.subject);
      setBody(template.bodyHtml);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const variables = extractVariables(subject, body);

  async function handleSave() {
    if (!name.trim() || !templateSlug.trim()) {
      setError("Name and slug are required");
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (isNew) {
        await api.createTemplate({
          slug: templateSlug,
          name,
          subject,
          bodyHtml: body,
        });
      } else {
        await api.updateTemplate(slug!, { name, subject, bodyHtml: body });
      }

      navigate("/templates");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <PageContainer>
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate("/templates")}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-bg-muted hover:text-text-primary"
            >
              <ArrowLeft size={16} />
              Templates
            </button>
            <span className="text-text-tertiary">/</span>
            <h1 className="text-lg font-semibold text-text-primary">
              {isNew ? "New Template" : "Edit Template"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 size={16} className="mr-1.5 animate-spin" />
              ) : (
                <Save size={16} className="mr-1.5" />
              )}
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-[8px] border border-destructive/50 bg-destructive/10 px-4 py-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 [&>*]:min-w-0">
          {/* Main editor */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Template Content</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g., Welcome Email"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="slug">Slug</Label>
                    <Input
                      id="slug"
                      value={templateSlug}
                      onChange={(e) =>
                        setTemplateSlug(
                          e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
                        )
                      }
                      placeholder="e.g., welcome-email"
                      disabled={!isNew}
                    />
                    {!isNew && (
                      <p className="text-xs text-text-tertiary">
                        Slug cannot be changed after creation
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="subject">Subject</Label>
                  <Input
                    id="subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="e.g., Welcome to {{company_name}}!"
                  />
                </div>

                <div className="space-y-2">
                  <span className="text-sm font-medium leading-none text-text-primary">Body</span>
                  <TemplateBodyEditor
                    value={body}
                    onChange={setBody}
                    subject={subject}
                    variables={variables}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Variables</CardTitle>
              </CardHeader>
              <CardContent>
                {variables.length === 0 ? (
                  <p className="text-sm text-text-tertiary">
                    No variables detected. Use {"{{variable_name}}"} syntax.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {variables.map((v) => (
                      <Badge key={v} variant="secondary">
                        {`{{${v}}}`}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Syntax Reference</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-text-secondary">
                <div>
                  <code className="rounded bg-bg-subtle px-1">{"{{key}}"}</code>{" "}
                  — Variable placeholder
                </div>
                <div>
                  <code className="rounded bg-bg-subtle px-1">{"{{first_name}}"}</code>{" "}
                  — Recipient's first name
                </div>
                <div>
                  <code className="rounded bg-bg-subtle px-1">{"{{company_name}}"}</code>{" "}
                  — Your company name
                </div>
                <div>
                  <code className="rounded bg-bg-subtle px-1">{"{{unsubscribe_url}}"}</code>{" "}
                  — Unsubscribe link
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageContainer>
    </DashboardLayout>
  );
}
