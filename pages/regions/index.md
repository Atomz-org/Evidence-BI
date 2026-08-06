---
title: Regions
---

Drill-down pages per customer region (plus the guest-checkout bucket, which has
no customer record). Each page carries region-filtered KPIs, the daily revenue
trend, and a full order log for audit.

```sql region_index
select distinct
    region,
    '/regions/' || region as region_url
from dbt_semantic.orders
order by region
```

<DataTable data={region_index} link=region_url>
  <Column id=region title="Region"/>
</DataTable>
