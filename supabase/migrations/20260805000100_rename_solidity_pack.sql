begin;

update public.card_packs
set title = 'Solidity 101：循序渐进实战课',
    updated_at = now()
where slug = 'solidity-foundations';

update public.learning_projects as projects
set title = 'Solidity 101：循序渐进实战课',
    updated_at = now()
from public.card_pack_versions as versions
join public.card_packs as packs on packs.pack_id = versions.pack_id
where projects.project_kind = 'PACK'
  and projects.pack_version_id = versions.pack_version_id
  and packs.slug = 'solidity-foundations';

commit;
