select region, count(*) as n, max(ordered_at) as latest
from orders group by 1 order by 1
