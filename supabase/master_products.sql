create table if not exists public.master_products_v2 (
  id uuid primary key default gen_random_uuid(),
  country text not null,
  shop text not null,
  name text not null,
  name_key text not null,
  category text not null,
  subcategory text not null,
  placement text not null,
  amount text,
  unit text,
  price_regular text,
  price_regular_unit text,
  price_sale text,
  price_sale_unit text,
  info text,
  date_from text,
  date_to text,
  created_at timestamptz not null default now()
);

create unique index if not exists master_products_v2_unique
  on public.master_products_v2 (country, shop, name_key);

create index if not exists master_products_v2_country_shop_idx
  on public.master_products_v2 (country, shop);

create index if not exists master_products_v2_name_key_idx
  on public.master_products_v2 (name_key);