/** @jsxImportSource react */
import { Card } from '@astryxdesign/core/Card';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

export function DashboardCard({
  title,
  description,
  href,
  children,
}: {
  title: string;
  description?: string;
  href?: string;
  children: ReactNode;
}) {
  const content = (
    <Layout
      height="auto"
      header={
        <LayoutHeader hasDivider padding={0}>
          <div className="void-admin-dashboard-card-heading">
            <div className="void-admin-dashboard-card-title">
              <Heading level={2}>{title}</Heading>
              {href && (
                <ChevronRight
                  className="void-admin-dashboard-card-arrow"
                  size={18}
                  aria-hidden="true"
                />
              )}
            </div>
            {description && <Text type="supporting">{description}</Text>}
          </div>
        </LayoutHeader>
      }
      content={<LayoutContent>{children}</LayoutContent>}
    />
  );
  if (href) {
    return (
      <ClickableCard className="void-admin-dashboard-card" label={title} href={href}>
        {content}
      </ClickableCard>
    );
  }
  return <Card className="void-admin-dashboard-card">{content}</Card>;
}
