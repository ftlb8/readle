-- How far through an article its owner has read, as a percentage. 100 means read.
alter table public.items
  add column read_progress smallint not null default 0
  check (read_progress between 0 and 100);
