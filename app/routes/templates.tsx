// Templates Page - Email templates management
import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { Plus, Search, FileText, MoreHorizontal, Trash2 } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import api from "~/services/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { EmptyState, PageContainer, PageHeader } from "~/components/ui/page";

interface Template {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  createdAt: number;
  updatedAt: number;
}

// Extract variables from template content
function extractVariables(subject: string, bodyHtml: string): string[] {
  const combined = `${subject} ${bodyHtml}`;
  const matches = combined.matchAll(/\{\{(\w+)\}\}/g);
  const vars = new Set<string>();
  for (const match of matches) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}

export default function TemplatesPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTemplates();
  }, []);

  async function fetchTemplates() {
    try {
      setLoading(true);
      setTemplates(await api.listTemplates());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(slug: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this template?")) return;
    
    try {
      await api.deleteTemplate(slug);
      setTemplates((prev) => prev.filter((t) => t.slug !== slug));
    } catch (e) {
      alert("Failed to delete template: " + (e as Error).message);
    }
  }

  const filteredTemplates = templates.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.slug.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <DashboardLayout>
      <PageContainer>
        <PageHeader
          icon={FileText}
          title="Templates"
          description={<>Reusable messages with placeholders like {"{{name}}"}, filled in when you send.</>}
          actions={
            (loading || templates.length > 0) && (
              <Button onClick={() => navigate("/templates/new")}>
                <Plus size={16} />
                New template
              </Button>
            )
          }
        />

        {/* Search */}
        {templates.length > 0 && (
        <div className="relative mb-6 max-w-md">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <Input
            type="search"
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        )}

        {/* Error state */}
        {error && (
          <Card className="mb-4 border-destructive/50 bg-destructive/10">
            <CardContent className="py-4">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={fetchTemplates} className="mt-2">
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Loading state */}
        {loading ? (
          <p className="text-sm text-text-tertiary">Loading…</p>
        ) : filteredTemplates.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            title={search ? "No templates match your search" : "No templates yet"}
            description={
              search
                ? "Try a different name."
                : "Save a message you send often, like a follow-up or an intro, and reuse it from the composer."
            }
            action={
              !search && (
                <Button onClick={() => navigate("/templates/new")}>
                  <Plus size={16} />
                  New template
                </Button>
              )
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredTemplates.map((template) => {
              const variables = extractVariables(template.subject, template.bodyHtml);
              return (
                <Card
                  key={template.id}
                  className="cursor-pointer transition-shadow hover:shadow-md"
                  onClick={() => navigate(`/templates/${template.slug}/edit`)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base">{template.name}</CardTitle>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="rounded p-1 text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/templates/${template.slug}/edit`);
                            }}
                          >
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={(e) => handleDelete(template.slug, e)}
                          >
                            <Trash2 size={14} className="mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <p className="text-xs text-text-tertiary">{template.slug}</p>
                  </CardHeader>
                  <CardContent>
                    <p className="mb-3 truncate text-sm text-text-secondary">
                      {template.subject}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {variables.slice(0, 3).map((v) => (
                        <Badge key={v} variant="secondary" className="text-xs">
                          {`{{${v}}}`}
                        </Badge>
                      ))}
                      {variables.length > 3 && (
                        <Badge variant="secondary" className="text-xs">
                          +{variables.length - 3} more
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </PageContainer>
    </DashboardLayout>
  );
}
