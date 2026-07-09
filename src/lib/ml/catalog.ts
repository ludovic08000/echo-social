export const ML_CLIENT_MODULES = {
  recsysV8: './recsysV8',
  feedAlgorithm: './feedAlgorithm',
  feedDiversity: './feedDiversity',
  feedPreferences: './feedPreferences',
  aiEngine: './aiEngine',
} as const;

export const ML_EDGE_FUNCTIONS = {
  feed: 'ml-feed',
  feedTrain: 'ml-feed-train',
  twoTowerTrain: 'ml-twotower-train',
  matching: 'ml-matching',
  moderation: 'ml-moderation',
  fraudDetect: 'ml-fraud-detect',
  feedScoring: 'feed-scoring',
  feedOptimizer: 'feed-optimizer',
  aiEngine: 'ai-engine',
  aiContent: 'ai-content',
} as const;

export const ML_FEED_RPC = {
  getFeedPostsV7: 'get_feed_posts',
  getFeedPostsV8: 'get_feed_posts_v8',
  feedScoreBatch: 'feed_score_batch',
  videoScoreBatch: 'video_score_batch',
  liveScoreBatch: 'live_score_batch',
  liveFeedBundle: 'live_feed_bundle',
  recsysV8Assignment: 'ml_recsys_v8_assignment',
  retrieveFeedCandidatesV8: 'ml_retrieve_feed_candidates_v8',
  recordFeedAbEvents: 'ml_record_feed_ab_events',
  queuePostEmbedding: 'ml_queue_post_embedding',
  queueUserEmbedding: 'ml_queue_user_embedding',
  refreshCreatorFeaturesV8: 'ml_refresh_creator_features_v8',
} as const;

export const ML_SERVER_MIGRATIONS = [
  '20260624103000_recsys_v7_feed_live_video.sql',
  '20260704120000_recsys_v8_embedding_retrieval_rerank.sql',
  '20260705120000_ml_embeddings_hnsw_unified.sql',
  '20260705153000_finalize_kt_linked_device_ml_offline.sql',
] as const;
