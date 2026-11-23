-- BAK-08: photos are compressed before upload (long edge and JPEG quality from the API's settings, about 1 MB), on the
-- web and on the phone. A person can keep their originals instead. The design (07 §BAK-08) keeps an original only when
-- the person opts in, so the choice is per user and off by default. The web also offers it per upload.
--
-- Additive: old API tasks during a deploy don't read the column, and the default keeps them correct.

alter table app.app_user add column keep_original_photos boolean not null default false;
