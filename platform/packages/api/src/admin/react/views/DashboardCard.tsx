/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Card } from '@astryxdesign/core/Card';
import { Layout, LayoutContent, LayoutHeader } from '@astryxdesign/core/Layout';
import { Heading, Text } from '@astryxdesign/core/Text';
import type { ReactNode } from 'react';

export function DashboardCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="void-admin-dashboard-card">
      <Layout
        height="auto"
        header={
          <LayoutHeader hasDivider>
            <div className="void-admin-dashboard-card-heading">
              <Heading level={2}>{title}</Heading>
              {description && <Text type="supporting">{description}</Text>}
            </div>
          </LayoutHeader>
        }
        content={<LayoutContent>{children}</LayoutContent>}
      />
    </Card>
  );
}
