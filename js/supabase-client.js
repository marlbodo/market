// Supabase 연결 설정
// ⚠️ RLS(Row Level Security)가 비활성화된 테이블은 이 공개 키로 읽기/쓰기가 모두 가능합니다.
// GitHub에 이 파일이 그대로 올라가면 누구나 값을 볼 수 있으니,
// 운영 전 Supabase 대시보드에서 각 테이블에 "읽기 전용 RLS 정책"을 걸어주세요.
const SUPABASE_URL = 'https://hnxvsopwxiamexnxczhj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1_9-bKTcV3sBQkv10ru__w_iW-51pKt';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);
