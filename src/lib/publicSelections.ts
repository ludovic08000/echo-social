// Liste explicite : une lecture publique ne demande jamais une colonne réservée au serveur/propriétaire.
export const LIVE_PUBLIC_COLUMNS='id,user_id,title,description,thumbnail_url,is_active,viewer_count,peak_viewer_count,total_views,category,hashtags,started_at,ended_at,recording_url,created_at' as const;
export const SELLER_PUBLIC_COLUMNS='id,user_id,store_name,store_description,store_logo_url,store_banner_url,is_verified,is_active,total_sales,rating_average,rating_count,created_at,updated_at' as const;
