create policy "no direct access to product scan usage"
on private.product_scan_usage
as restrictive
for all
to public
using (false)
with check (false);

