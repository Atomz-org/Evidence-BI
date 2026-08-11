select region, count() as n, sum(amount) as total, toDateTime64(max(ordered_at),3) as latest
from default.orders group by region order by region
