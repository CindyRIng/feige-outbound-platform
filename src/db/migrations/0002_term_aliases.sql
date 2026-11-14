-- 0002_term_aliases.sql
-- schema v2：内置「孚盟」词表种子补全为 docs/13 §5 规定的 9 个同音变体
-- 背景：0001 内置仅 3 个变体（复萌/福梦/复盟），实测 ASR 输出集中在 福盟/富盟/福蒙 → 归一未命中；
--       v0.3.2 起通过本迁移统一升级（新装先 0001 再 0002；已有库仅执行 0002）。
-- 幂等：仅更新未删除的「孚盟」规则；重复执行结果一致（checksum 由 schema_version 守护）。

UPDATE term_rules
   SET from_aliases_json = '["复萌","复盟","福萌","福盟","富盟","福梦","弗盟","孚蒙","福蒙"]',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       version = version + 1
 WHERE to_term = '孚盟'
   AND deleted_at IS NULL;
