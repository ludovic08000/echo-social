export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ab_tests: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          ended_at: string | null
          id: string
          name: string
          results_a: Json | null
          results_b: Json | null
          started_at: string | null
          status: string
          target_metric: string
          test_type: string
          traffic_split: number
          updated_at: string
          variant_a: Json
          variant_b: Json
          winner: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          ended_at?: string | null
          id?: string
          name: string
          results_a?: Json | null
          results_b?: Json | null
          started_at?: string | null
          status?: string
          target_metric?: string
          test_type?: string
          traffic_split?: number
          updated_at?: string
          variant_a?: Json
          variant_b?: Json
          winner?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          ended_at?: string | null
          id?: string
          name?: string
          results_a?: Json | null
          results_b?: Json | null
          started_at?: string | null
          status?: string
          target_metric?: string
          test_type?: string
          traffic_split?: number
          updated_at?: string
          variant_a?: Json
          variant_b?: Json
          winner?: string | null
        }
        Relationships: []
      }
      abuse_reports: {
        Row: {
          created_at: string
          description: string | null
          evidence_urls: string[] | null
          id: string
          report_type: string
          reported_user_id: string
          reporter_id: string
          resolution: string | null
          reviewed_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          evidence_urls?: string[] | null
          id?: string
          report_type?: string
          reported_user_id: string
          reporter_id: string
          resolution?: string | null
          reviewed_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          evidence_urls?: string[] | null
          id?: string
          report_type?: string
          reported_user_id?: string
          reporter_id?: string
          resolution?: string | null
          reviewed_at?: string | null
          status?: string
        }
        Relationships: []
      }
      account_deletion_requests: {
        Row: {
          completed_at: string | null
          confirmation_token: string | null
          confirmed_at: string | null
          created_at: string
          id: string
          reason: string | null
          scheduled_deletion_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          confirmation_token?: string | null
          confirmed_at?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          scheduled_deletion_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          confirmation_token?: string | null
          confirmed_at?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          scheduled_deletion_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      active_calls: {
        Row: {
          accepted_by: string[] | null
          answered_at: string | null
          call_type: string
          callee_id: string
          caller_id: string
          caller_ids: string[] | null
          conversation_id: string
          created_at: string
          declined_by: string[] | null
          encrypted_call_key: string | null
          ended_at: string | null
          id: string
          is_group: boolean
          room_id: string | null
          status: string
        }
        Insert: {
          accepted_by?: string[] | null
          answered_at?: string | null
          call_type?: string
          callee_id: string
          caller_id: string
          caller_ids?: string[] | null
          conversation_id: string
          created_at?: string
          declined_by?: string[] | null
          encrypted_call_key?: string | null
          ended_at?: string | null
          id?: string
          is_group?: boolean
          room_id?: string | null
          status?: string
        }
        Update: {
          accepted_by?: string[] | null
          answered_at?: string | null
          call_type?: string
          callee_id?: string
          caller_id?: string
          caller_ids?: string[] | null
          conversation_id?: string
          created_at?: string
          declined_by?: string[] | null
          encrypted_call_key?: string | null
          ended_at?: string | null
          id?: string
          is_group?: boolean
          room_id?: string | null
          status?: string
        }
        Relationships: []
      }
      ad_campaigns: {
        Row: {
          advertiser_id: string
          body: string
          budget: number
          clicks: number
          created_at: string
          cta_text: string | null
          cta_url: string | null
          daily_budget: number | null
          duration_type: string
          ends_at: string
          id: string
          image_url: string | null
          impressions: number
          moderation_reason: string | null
          moderation_status: string | null
          reach: number
          spent: number
          starts_at: string
          status: string
          target_age_max: number | null
          target_age_min: number | null
          target_audience: Json | null
          target_gender: string | null
          target_interests: string[] | null
          target_location: Json | null
          title: string
          updated_at: string
          video_url: string | null
        }
        Insert: {
          advertiser_id: string
          body: string
          budget?: number
          clicks?: number
          created_at?: string
          cta_text?: string | null
          cta_url?: string | null
          daily_budget?: number | null
          duration_type?: string
          ends_at: string
          id?: string
          image_url?: string | null
          impressions?: number
          moderation_reason?: string | null
          moderation_status?: string | null
          reach?: number
          spent?: number
          starts_at?: string
          status?: string
          target_age_max?: number | null
          target_age_min?: number | null
          target_audience?: Json | null
          target_gender?: string | null
          target_interests?: string[] | null
          target_location?: Json | null
          title: string
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          advertiser_id?: string
          body?: string
          budget?: number
          clicks?: number
          created_at?: string
          cta_text?: string | null
          cta_url?: string | null
          daily_budget?: number | null
          duration_type?: string
          ends_at?: string
          id?: string
          image_url?: string | null
          impressions?: number
          moderation_reason?: string | null
          moderation_status?: string | null
          reach?: number
          spent?: number
          starts_at?: string
          status?: string
          target_age_max?: number | null
          target_age_min?: number | null
          target_audience?: Json | null
          target_gender?: string | null
          target_interests?: string[] | null
          target_location?: Json | null
          title?: string
          updated_at?: string
          video_url?: string | null
        }
        Relationships: []
      }
      ad_daily_stats: {
        Row: {
          campaign_id: string
          clicks: number
          created_at: string
          id: string
          impressions: number
          reach: number
          spent: number
          stat_date: string
        }
        Insert: {
          campaign_id: string
          clicks?: number
          created_at?: string
          id?: string
          impressions?: number
          reach?: number
          spent?: number
          stat_date?: string
        }
        Update: {
          campaign_id?: string
          clicks?: number
          created_at?: string
          id?: string
          impressions?: number
          reach?: number
          spent?: number
          stat_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_daily_stats_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "ad_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_interactions: {
        Row: {
          campaign_id: string
          created_at: string
          id: string
          interaction_type: string
          user_id: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          id?: string
          interaction_type?: string
          user_id: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          id?: string
          interaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_interactions_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "ad_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_conversations: {
        Row: {
          agent_id: string
          created_at: string
          id: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          id?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_conversations_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role?: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_agent_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agent_usage: {
        Row: {
          agent_id: string
          created_at: string
          id: string
          message_count: number
          usage_date: string
          user_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          id?: string
          message_count?: number
          usage_date?: string
          user_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          id?: string
          message_count?: number
          usage_date?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_agent_usage_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "ai_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_agents: {
        Row: {
          category: string
          created_at: string
          description: string | null
          free_messages_per_day: number
          icon: string
          id: string
          is_active: boolean
          is_premium: boolean
          name: string
          slug: string
          sort_order: number
          system_prompt: string
          updated_at: string
          welcome_message: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          description?: string | null
          free_messages_per_day?: number
          icon?: string
          id?: string
          is_active?: boolean
          is_premium?: boolean
          name: string
          slug: string
          sort_order?: number
          system_prompt: string
          updated_at?: string
          welcome_message?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          free_messages_per_day?: number
          icon?: string
          id?: string
          is_active?: boolean
          is_premium?: boolean
          name?: string
          slug?: string
          sort_order?: number
          system_prompt?: string
          updated_at?: string
          welcome_message?: string | null
        }
        Relationships: []
      }
      ai_engine_events: {
        Row: {
          action: string | null
          created_at: string
          id: string
          latency_ms: number
          module_id: string
          source: string
          success: boolean
          user_id: string | null
        }
        Insert: {
          action?: string | null
          created_at?: string
          id?: string
          latency_ms?: number
          module_id: string
          source: string
          success?: boolean
          user_id?: string | null
        }
        Update: {
          action?: string | null
          created_at?: string
          id?: string
          latency_ms?: number
          module_id?: string
          source?: string
          success?: boolean
          user_id?: string | null
        }
        Relationships: []
      }
      ai_feedback: {
        Row: {
          ai_decision: string
          created_at: string
          human_decision: string
          id: string
          original_text: string
          reason: string | null
          user_id: string
        }
        Insert: {
          ai_decision: string
          created_at?: string
          human_decision: string
          id?: string
          original_text: string
          reason?: string | null
          user_id: string
        }
        Update: {
          ai_decision?: string
          created_at?: string
          human_decision?: string
          id?: string
          original_text?: string
          reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      ai_learned_rules: {
        Row: {
          created_at: string
          id: string
          pattern: string | null
          rule: string
          source_feedback_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          pattern?: string | null
          rule: string
          source_feedback_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          pattern?: string | null
          rule?: string
          source_feedback_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_learned_rules_source_feedback_id_fkey"
            columns: ["source_feedback_id"]
            isOneToOne: false
            referencedRelation: "ai_feedback"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_metrics_log: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          metric_type: string
          module_id: string
          value: number
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          metric_type?: string
          module_id: string
          value?: number
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          metric_type?: string
          module_id?: string
          value?: number
        }
        Relationships: []
      }
      ai_moderation_cache: {
        Row: {
          content_hash: string
          created_at: string
          expires_at: string
          id: string
          result: Json
        }
        Insert: {
          content_hash: string
          created_at?: string
          expires_at?: string
          id?: string
          result: Json
        }
        Update: {
          content_hash?: string
          created_at?: string
          expires_at?: string
          id?: string
          result?: Json
        }
        Relationships: []
      }
      album_media: {
        Row: {
          album_id: string
          caption: string | null
          created_at: string
          id: string
          media_type: string
          media_url: string
          user_id: string
        }
        Insert: {
          album_id: string
          caption?: string | null
          created_at?: string
          id?: string
          media_type?: string
          media_url: string
          user_id: string
        }
        Update: {
          album_id?: string
          caption?: string | null
          created_at?: string
          id?: string
          media_type?: string
          media_url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "album_media_album_id_fkey"
            columns: ["album_id"]
            isOneToOne: false
            referencedRelation: "albums"
            referencedColumns: ["id"]
          },
        ]
      }
      albums: {
        Row: {
          cover_url: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          privacy: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cover_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          privacy?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cover_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          privacy?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      anonymous_wall_messages: {
        Row: {
          author_id: string
          created_at: string
          id: string
          is_approved: boolean
          message: string
          target_user_id: string
        }
        Insert: {
          author_id: string
          created_at?: string
          id?: string
          is_approved?: boolean
          message: string
          target_user_id: string
        }
        Update: {
          author_id?: string
          created_at?: string
          id?: string
          is_approved?: boolean
          message?: string
          target_user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          conversation_id: string | null
          created_at: string
          device_fingerprint: string | null
          event_type: string
          id: string
          live_id: string | null
          media_id: string | null
          metadata: Json | null
          post_id: string | null
          reason_code: string | null
          status: string | null
          target_user_id: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          device_fingerprint?: string | null
          event_type: string
          id?: string
          live_id?: string | null
          media_id?: string | null
          metadata?: Json | null
          post_id?: string | null
          reason_code?: string | null
          status?: string | null
          target_user_id?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          device_fingerprint?: string | null
          event_type?: string
          id?: string
          live_id?: string | null
          media_id?: string | null
          metadata?: Json | null
          post_id?: string | null
          reason_code?: string | null
          status?: string | null
          target_user_id?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      backup_pin_state: {
        Row: {
          attempts_count: number
          attempts_window_start: string
          created_at: string
          kdf_version: number
          locked_until: string | null
          pin_wrap_master: string
          salt: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts_count?: number
          attempts_window_start?: string
          created_at?: string
          kdf_version?: number
          locked_until?: string | null
          pin_wrap_master: string
          salt: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts_count?: number
          attempts_window_start?: string
          created_at?: string
          kdf_version?: number
          locked_until?: string | null
          pin_wrap_master?: string
          salt?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      banned_emails: {
        Row: {
          associated_user_id: string | null
          banned_at: string
          banned_by: string
          email: string
          id: string
          is_active: boolean
          reason: string | null
        }
        Insert: {
          associated_user_id?: string | null
          banned_at?: string
          banned_by: string
          email: string
          id?: string
          is_active?: boolean
          reason?: string | null
        }
        Update: {
          associated_user_id?: string | null
          banned_at?: string
          banned_by?: string
          email?: string
          id?: string
          is_active?: boolean
          reason?: string | null
        }
        Relationships: []
      }
      banned_ips: {
        Row: {
          banned_at: string
          banned_by: string
          expires_at: string | null
          id: string
          ip_address: string
          is_active: boolean
          reason: string | null
        }
        Insert: {
          banned_at?: string
          banned_by: string
          expires_at?: string | null
          id?: string
          ip_address: string
          is_active?: boolean
          reason?: string | null
        }
        Update: {
          banned_at?: string
          banned_by?: string
          expires_at?: string | null
          id?: string
          ip_address?: string
          is_active?: boolean
          reason?: string | null
        }
        Relationships: []
      }
      banned_users: {
        Row: {
          banned_at: string
          banned_by: string
          expires_at: string | null
          id: string
          is_active: boolean
          reason: string | null
          user_id: string
        }
        Insert: {
          banned_at?: string
          banned_by: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          reason?: string | null
          user_id: string
        }
        Update: {
          banned_at?: string
          banned_by?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      call_history: {
        Row: {
          call_id: string | null
          call_type: string
          callee_id: string
          caller_id: string
          conversation_id: string
          duration_seconds: number
          ended_at: string
          final_status: string
          id: string
          is_group: boolean
          participants: string[] | null
          started_at: string
        }
        Insert: {
          call_id?: string | null
          call_type?: string
          callee_id: string
          caller_id: string
          conversation_id: string
          duration_seconds?: number
          ended_at?: string
          final_status: string
          id?: string
          is_group?: boolean
          participants?: string[] | null
          started_at?: string
        }
        Update: {
          call_id?: string | null
          call_type?: string
          callee_id?: string
          caller_id?: string
          conversation_id?: string
          duration_seconds?: number
          ended_at?: string
          final_status?: string
          id?: string
          is_group?: boolean
          participants?: string[] | null
          started_at?: string
        }
        Relationships: []
      }
      cart_items: {
        Row: {
          created_at: string
          id: string
          product_id: string
          quantity: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          quantity?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          quantity?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cart_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      challenge_participants: {
        Row: {
          challenge_id: string
          id: string
          joined_at: string
          user_id: string
        }
        Insert: {
          challenge_id: string
          id?: string
          joined_at?: string
          user_id: string
        }
        Update: {
          challenge_id?: string
          id?: string
          joined_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenge_participants_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      challenge_submissions: {
        Row: {
          challenge_id: string
          content: string | null
          created_at: string
          id: string
          image_url: string | null
          user_id: string
          votes: number
        }
        Insert: {
          challenge_id: string
          content?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          user_id: string
          votes?: number
        }
        Update: {
          challenge_id?: string
          content?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          user_id?: string
          votes?: number
        }
        Relationships: [
          {
            foreignKeyName: "challenge_submissions_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
        ]
      }
      challenges: {
        Row: {
          challenge_type: string
          created_at: string
          creator_id: string
          description: string | null
          ends_at: string
          id: string
          image_url: string | null
          starts_at: string
          title: string
        }
        Insert: {
          challenge_type?: string
          created_at?: string
          creator_id: string
          description?: string | null
          ends_at: string
          id?: string
          image_url?: string | null
          starts_at?: string
          title: string
        }
        Update: {
          challenge_type?: string
          created_at?: string
          creator_id?: string
          description?: string | null
          ends_at?: string
          id?: string
          image_url?: string | null
          starts_at?: string
          title?: string
        }
        Relationships: []
      }
      comment_likes: {
        Row: {
          comment_id: string
          created_at: string
          id: string
          reaction_type: string
          user_id: string
        }
        Insert: {
          comment_id: string
          created_at?: string
          id?: string
          reaction_type?: string
          user_id: string
        }
        Update: {
          comment_id?: string
          created_at?: string
          id?: string
          reaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_likes_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
        ]
      }
      comment_moderation_alerts: {
        Row: {
          ai_reasoning: string | null
          category: string
          comment_id: string | null
          created_at: string
          evidence_text: string
          id: string
          post_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          severity: string
          status: string
          strike_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          ai_reasoning?: string | null
          category: string
          comment_id?: string | null
          created_at?: string
          evidence_text: string
          id?: string
          post_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: string
          strike_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          ai_reasoning?: string | null
          category?: string
          comment_id?: string | null
          created_at?: string
          evidence_text?: string
          id?: string
          post_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: string
          strike_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_moderation_alerts_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_moderation_alerts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_moderation_alerts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          body: string
          created_at: string
          id: string
          is_zeus_reply: boolean
          parent_id: string | null
          post_id: string
          user_id: string | null
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_zeus_reply?: boolean
          parent_id?: string | null
          post_id: string
          user_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_zeus_reply?: boolean
          parent_id?: string | null
          post_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      content_strikes: {
        Row: {
          acknowledged: boolean | null
          created_at: string | null
          id: string
          post_id: string | null
          reason: string
          severity: string | null
          user_id: string
          zeus_message: string | null
        }
        Insert: {
          acknowledged?: boolean | null
          created_at?: string | null
          id?: string
          post_id?: string | null
          reason: string
          severity?: string | null
          user_id: string
          zeus_message?: string | null
        }
        Update: {
          acknowledged?: boolean | null
          created_at?: string | null
          id?: string
          post_id?: string | null
          reason?: string
          severity?: string | null
          user_id?: string
          zeus_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_strikes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_strikes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_archive_keys: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          kdf_version: number
          rotated_at: string | null
          user_id: string
          wrapped_key: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          kdf_version?: number
          rotated_at?: string | null
          user_id: string
          wrapped_key: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          kdf_version?: number
          rotated_at?: string | null
          user_id?: string
          wrapped_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_archive_keys_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_participants: {
        Row: {
          conversation_id: string
          id: string
          joined_at: string
          last_read_at: string | null
          user_id: string
        }
        Insert: {
          conversation_id: string
          id?: string
          joined_at?: string
          last_read_at?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          id?: string
          joined_at?: string
          last_read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_participants_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          created_by: string | null
          disappearing_seconds: number | null
          enable_sender_keys: boolean
          id: string
          is_group: boolean
          name: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          disappearing_seconds?: number | null
          enable_sender_keys?: boolean
          id?: string
          is_group?: boolean
          name?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          disappearing_seconds?: number | null
          enable_sender_keys?: boolean
          id?: string
          is_group?: boolean
          name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      creator_subscriptions: {
        Row: {
          cancelled_at: string | null
          created_at: string
          currency: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          plan: string
          price_cents: number
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          created_at?: string
          currency?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan?: string
          price_cents?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          created_at?: string
          currency?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan?: string
          price_cents?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      crypto_error_logs: {
        Row: {
          context: string
          conversation_id: string | null
          created_at: string
          error_code: string
          error_message: string
          id: string
          metadata: Json | null
          my_device_id: string | null
          peer_device_id: string | null
          peer_user_id: string | null
          severity: string
          stack: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          context: string
          conversation_id?: string | null
          created_at?: string
          error_code: string
          error_message: string
          id?: string
          metadata?: Json | null
          my_device_id?: string | null
          peer_device_id?: string | null
          peer_user_id?: string | null
          severity?: string
          stack?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          context?: string
          conversation_id?: string | null
          created_at?: string
          error_code?: string
          error_message?: string
          id?: string
          metadata?: Json | null
          my_device_id?: string | null
          peer_device_id?: string | null
          peer_user_id?: string | null
          severity?: string
          stack?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      data_export_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          download_url: string | null
          expires_at: string | null
          id: string
          status: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          download_url?: string | null
          expires_at?: string | null
          id?: string
          status?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          download_url?: string | null
          expires_at?: string | null
          id?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      ddos_ip_tracker: {
        Row: {
          blocked_until: string | null
          created_at: string
          endpoint: string
          id: string
          ip_address: string
          penalty_level: number
          request_count: number
          updated_at: string
          window_start: string
        }
        Insert: {
          blocked_until?: string | null
          created_at?: string
          endpoint?: string
          id?: string
          ip_address: string
          penalty_level?: number
          request_count?: number
          updated_at?: string
          window_start?: string
        }
        Update: {
          blocked_until?: string | null
          created_at?: string
          endpoint?: string
          id?: string
          ip_address?: string
          penalty_level?: number
          request_count?: number
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      device_copy_retry_requests: {
        Row: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          message_id: string
          requester_device_id: string
          requester_user_id: string
          sender_user_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          message_id: string
          requester_device_id: string
          requester_user_id: string
          sender_user_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          message_id?: string
          requester_device_id?: string
          requester_user_id?: string
          sender_user_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      device_fingerprints: {
        Row: {
          created_at: string
          fingerprint_hash: string
          id: string
          ip_address: string | null
          language: string | null
          last_seen_at: string
          screen_resolution: string | null
          timezone: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          fingerprint_hash: string
          id?: string
          ip_address?: string | null
          language?: string | null
          last_seen_at?: string
          screen_resolution?: string | null
          timezone?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          fingerprint_hash?: string
          id?: string
          ip_address?: string | null
          language?: string | null
          last_seen_at?: string
          screen_resolution?: string | null
          timezone?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      device_keys: {
        Row: {
          city: string | null
          country: string | null
          created_at: string
          device_hash: string
          device_label: string | null
          id: string
          ip_address: string | null
          last_seen_at: string
          region: string | null
          revoked_at: string | null
          status: string
          trusted_at: string | null
          user_agent: string | null
          user_id: string
          verification_sent_at: string | null
          verification_token: string | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string
          device_hash: string
          device_label?: string | null
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          region?: string | null
          revoked_at?: string | null
          status?: string
          trusted_at?: string | null
          user_agent?: string | null
          user_id: string
          verification_sent_at?: string | null
          verification_token?: string | null
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string
          device_hash?: string
          device_label?: string | null
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          region?: string | null
          revoked_at?: string | null
          status?: string
          trusted_at?: string | null
          user_agent?: string | null
          user_id?: string
          verification_sent_at?: string | null
          verification_token?: string | null
        }
        Relationships: []
      }
      device_link_requests: {
        Row: {
          approved_at: string | null
          approver_device_id: string | null
          claimed_at: string | null
          created_at: string
          encrypted_payload: string | null
          expires_at: string
          id: string
          requester_device_id: string
          requester_label: string | null
          requester_public_key: Json
          status: string
          token_hash: string
          user_id: string
        }
        Insert: {
          approved_at?: string | null
          approver_device_id?: string | null
          claimed_at?: string | null
          created_at?: string
          encrypted_payload?: string | null
          expires_at?: string
          id?: string
          requester_device_id: string
          requester_label?: string | null
          requester_public_key: Json
          status?: string
          token_hash: string
          user_id: string
        }
        Update: {
          approved_at?: string | null
          approver_device_id?: string | null
          claimed_at?: string | null
          created_at?: string
          encrypted_payload?: string | null
          expires_at?: string
          id?: string
          requester_device_id?: string
          requester_label?: string | null
          requester_public_key?: Json
          status?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      device_link_tokens: {
        Row: {
          claimed_at: string | null
          created_at: string
          encrypted_payload: string | null
          expires_at: string
          id: string
          token_hash: string
          user_id: string
        }
        Insert: {
          claimed_at?: string | null
          created_at?: string
          encrypted_payload?: string | null
          expires_at?: string
          id?: string
          token_hash: string
          user_id: string
        }
        Update: {
          claimed_at?: string | null
          created_at?: string
          encrypted_payload?: string | null
          expires_at?: string
          id?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      device_one_time_prekeys: {
        Row: {
          created_at: string
          device_id: string
          id: string
          opk_id: number
          public_key: string
          signature: string | null
          signature_version: number
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          id?: string
          opk_id: number
          public_key: string
          signature?: string | null
          signature_version?: number
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          id?: string
          opk_id?: number
          public_key?: string
          signature?: string | null
          signature_version?: number
          user_id?: string
        }
        Relationships: []
      }
      device_prekey_repair_requests: {
        Row: {
          created_at: string
          id: string
          owner_device_id: string
          owner_user_id: string
          reason: string
          reporter_user_id: string
          resolved_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          owner_device_id: string
          owner_user_id: string
          reason?: string
          reporter_user_id: string
          resolved_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          owner_device_id?: string
          owner_user_id?: string
          reason?: string
          reporter_user_id?: string
          resolved_at?: string | null
          status?: string
        }
        Relationships: []
      }
      device_primary_repair_requests: {
        Row: {
          candidate_device_ids: string[]
          created_at: string
          id: string
          reason: string
          resolved_at: string | null
          user_id: string
        }
        Insert: {
          candidate_device_ids?: string[]
          created_at?: string
          id?: string
          reason: string
          resolved_at?: string | null
          user_id: string
        }
        Update: {
          candidate_device_ids?: string[]
          created_at?: string
          id?: string
          reason?: string
          resolved_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      device_signed_prekeys: {
        Row: {
          created_at: string
          device_id: string
          expires_at: string
          id: string
          is_active: boolean
          is_last_resort: boolean
          keys_epoch: number
          public_key: string
          signature: string
          signature_version: number
          spk_id: number
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          expires_at?: string
          id?: string
          is_active?: boolean
          is_last_resort?: boolean
          keys_epoch?: number
          public_key: string
          signature: string
          signature_version?: number
          spk_id: number
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          expires_at?: string
          id?: string
          is_active?: boolean
          is_last_resort?: boolean
          keys_epoch?: number
          public_key?: string
          signature?: string
          signature_version?: number
          spk_id?: number
          user_id?: string
        }
        Relationships: []
      }
      e2ee_kt_leaves: {
        Row: {
          epoch: number
          leaf_hash: string
          leaf_index: number
          log_id: number
        }
        Insert: {
          epoch: number
          leaf_hash: string
          leaf_index: number
          log_id: number
        }
        Update: {
          epoch?: number
          leaf_hash?: string
          leaf_index?: number
          log_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_kt_leaves_epoch_fkey"
            columns: ["epoch"]
            isOneToOne: false
            referencedRelation: "e2ee_kt_tree_heads"
            referencedColumns: ["epoch"]
          },
          {
            foreignKeyName: "e2ee_kt_leaves_log_id_fkey"
            columns: ["log_id"]
            isOneToOne: false
            referencedRelation: "e2ee_transparency_log"
            referencedColumns: ["id"]
          },
        ]
      }
      e2ee_kt_signing_keys: {
        Row: {
          active: boolean
          algorithm: string
          created_at: string
          id: string
          public_key_jwk: Json
          retired_at: string | null
        }
        Insert: {
          active?: boolean
          algorithm?: string
          created_at?: string
          id?: string
          public_key_jwk: Json
          retired_at?: string | null
        }
        Update: {
          active?: boolean
          algorithm?: string
          created_at?: string
          id?: string
          public_key_jwk?: Json
          retired_at?: string | null
        }
        Relationships: []
      }
      e2ee_kt_tree_heads: {
        Row: {
          created_at: string
          epoch: number
          leaf_count: number
          prev_epoch: number | null
          root_hash: string
          signature: string
          signing_key_id: string
        }
        Insert: {
          created_at?: string
          epoch: number
          leaf_count: number
          prev_epoch?: number | null
          root_hash: string
          signature: string
          signing_key_id: string
        }
        Update: {
          created_at?: string
          epoch?: number
          leaf_count?: number
          prev_epoch?: number | null
          root_hash?: string
          signature?: string
          signing_key_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "e2ee_kt_tree_heads_prev_epoch_fkey"
            columns: ["prev_epoch"]
            isOneToOne: false
            referencedRelation: "e2ee_kt_tree_heads"
            referencedColumns: ["epoch"]
          },
        ]
      }
      e2ee_transparency_log: {
        Row: {
          created_at: string
          device_id: string | null
          event_type: string
          fingerprint: string | null
          id: number
          identity_epoch: number | null
          included_in_epoch: number | null
          leaf_hash: string | null
          payload: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id?: string | null
          event_type: string
          fingerprint?: string | null
          id?: number
          identity_epoch?: number | null
          included_in_epoch?: number | null
          leaf_hash?: string | null
          payload?: Json
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string | null
          event_type?: string
          fingerprint?: string | null
          id?: number
          identity_epoch?: number | null
          included_in_epoch?: number | null
          leaf_hash?: string | null
          payload?: Json
          user_id?: string
        }
        Relationships: []
      }
      edge_rate_limits: {
        Row: {
          count: number
          key: string
          window_start: string
        }
        Insert: {
          count?: number
          key: string
          window_start?: string
        }
        Update: {
          count?: number
          key?: string
          window_start?: string
        }
        Relationships: []
      }
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      feed_ai_recommendations: {
        Row: {
          applied_at: string | null
          auto_applicable: boolean
          created_at: string
          description: string
          dismissed_at: string | null
          id: string
          recommendation_type: string
          safe_bounds: Json | null
          severity: string
          status: string
          suggested_action: Json | null
          title: string
        }
        Insert: {
          applied_at?: string | null
          auto_applicable?: boolean
          created_at?: string
          description: string
          dismissed_at?: string | null
          id?: string
          recommendation_type: string
          safe_bounds?: Json | null
          severity?: string
          status?: string
          suggested_action?: Json | null
          title: string
        }
        Update: {
          applied_at?: string | null
          auto_applicable?: boolean
          created_at?: string
          description?: string
          dismissed_at?: string | null
          id?: string
          recommendation_type?: string
          safe_bounds?: Json | null
          severity?: string
          status?: string
          suggested_action?: Json | null
          title?: string
        }
        Relationships: []
      }
      feed_algorithm_config: {
        Row: {
          description: string | null
          id: string
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      feed_config_change_log: {
        Row: {
          ai_level: string | null
          applied_by: string | null
          change_source: string
          config_key: string
          created_at: string
          id: string
          new_value: Json
          old_value: Json | null
          reason: string | null
          rolled_back: boolean
          rolled_back_at: string | null
        }
        Insert: {
          ai_level?: string | null
          applied_by?: string | null
          change_source?: string
          config_key: string
          created_at?: string
          id?: string
          new_value: Json
          old_value?: Json | null
          reason?: string | null
          rolled_back?: boolean
          rolled_back_at?: string | null
        }
        Update: {
          ai_level?: string | null
          applied_by?: string | null
          change_source?: string
          config_key?: string
          created_at?: string
          id?: string
          new_value?: Json
          old_value?: Json | null
          reason?: string | null
          rolled_back?: boolean
          rolled_back_at?: string | null
        }
        Relationships: []
      }
      feed_learning_insights: {
        Row: {
          applied_at: string | null
          category: string
          confidence: number | null
          created_at: string
          data: Json | null
          description: string | null
          expires_at: string | null
          id: string
          insight_type: string
          is_applied: boolean | null
          title: string
        }
        Insert: {
          applied_at?: string | null
          category?: string
          confidence?: number | null
          created_at?: string
          data?: Json | null
          description?: string | null
          expires_at?: string | null
          id?: string
          insight_type?: string
          is_applied?: boolean | null
          title: string
        }
        Update: {
          applied_at?: string | null
          category?: string
          confidence?: number | null
          created_at?: string
          data?: Json | null
          description?: string | null
          expires_at?: string | null
          id?: string
          insight_type?: string
          is_applied?: boolean | null
          title?: string
        }
        Relationships: []
      }
      feed_learning_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          duration_ms: number | null
          error_message: string | null
          id: string
          moderation_rules_created: number | null
          posts_analyzed: number | null
          run_type: string
          status: string
          summary: Json | null
          trends_detected: number | null
          users_profiled: number | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          moderation_rules_created?: number | null
          posts_analyzed?: number | null
          run_type?: string
          status?: string
          summary?: Json | null
          trends_detected?: number | null
          users_profiled?: number | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          moderation_rules_created?: number | null
          posts_analyzed?: number | null
          run_type?: string
          status?: string
          summary?: Json | null
          trends_detected?: number | null
          users_profiled?: number | null
        }
        Relationships: []
      }
      feed_performance_metrics: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          metric_type: string
          session_id: string
          user_id: string
          value: number
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          metric_type: string
          session_id: string
          user_id: string
          value: number
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          metric_type?: string
          session_id?: string
          user_id?: string
          value?: number
        }
        Relationships: []
      }
      feed_score_cache: {
        Row: {
          computed_at: string
          id: string
          post_id: string
          score: number
          scoring_factors: Json | null
          user_id: string
        }
        Insert: {
          computed_at?: string
          id?: string
          post_id: string
          score?: number
          scoring_factors?: Json | null
          user_id: string
        }
        Update: {
          computed_at?: string
          id?: string
          post_id?: string
          score?: number
          scoring_factors?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feed_score_cache_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feed_score_cache_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      feed_score_tamper_events: {
        Row: {
          applied_algo: string | null
          created_at: string
          id: number
          post_count: number | null
          requested_algo: string | null
          user_id: string | null
        }
        Insert: {
          applied_algo?: string | null
          created_at?: string
          id?: number
          post_count?: number | null
          requested_algo?: string | null
          user_id?: string | null
        }
        Update: {
          applied_algo?: string | null
          created_at?: string
          id?: number
          post_count?: number | null
          requested_algo?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      friend_group_members: {
        Row: {
          added_at: string
          friend_user_id: string
          group_id: string
          id: string
        }
        Insert: {
          added_at?: string
          friend_user_id: string
          group_id: string
          id?: string
        }
        Update: {
          added_at?: string
          friend_user_id?: string
          group_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "friend_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "friend_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      friend_groups: {
        Row: {
          color: string | null
          created_at: string
          icon: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          icon?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          color?: string | null
          created_at?: string
          icon?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      friendships: {
        Row: {
          addressee_id: string
          created_at: string
          id: string
          requester_id: string
          status: Database["public"]["Enums"]["friendship_status"]
          updated_at: string
        }
        Insert: {
          addressee_id: string
          created_at?: string
          id?: string
          requester_id: string
          status?: Database["public"]["Enums"]["friendship_status"]
          updated_at?: string
        }
        Update: {
          addressee_id?: string
          created_at?: string
          id?: string
          requester_id?: string
          status?: Database["public"]["Enums"]["friendship_status"]
          updated_at?: string
        }
        Relationships: []
      }
      group_members: {
        Row: {
          group_id: string
          id: string
          joined_at: string
          role: string
          user_id: string
        }
        Insert: {
          group_id: string
          id?: string
          joined_at?: string
          role?: string
          user_id: string
        }
        Update: {
          group_id?: string
          id?: string
          joined_at?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_posts: {
        Row: {
          body: string
          created_at: string
          group_id: string
          id: string
          image_url: string | null
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          group_id: string
          id?: string
          image_url?: string | null
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          group_id?: string
          id?: string
          image_url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_posts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          cover_image_url: string | null
          created_at: string
          created_by: string
          description: string | null
          id: string
          name: string
          privacy: string
          updated_at: string
        }
        Insert: {
          cover_image_url?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          name: string
          privacy?: string
          updated_at?: string
        }
        Update: {
          cover_image_url?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          name?: string
          privacy?: string
          updated_at?: string
        }
        Relationships: []
      }
      identity_theft_archives: {
        Row: {
          admin_notes: string | null
          archived_at: string
          archived_by: string
          case_number: string
          connection_logs: Json
          created_at: string
          device_fingerprints: Json
          id: string
          ip_addresses: string[]
          legal_complaint_date: string | null
          legal_complaint_filed: boolean
          legal_reference: string | null
          profile_snapshot: Json | null
          screenshots_urls: string[]
          status: string
          usurper_avatar_url: string | null
          usurper_bio: string | null
          usurper_email: string | null
          usurper_name: string | null
          usurper_user_id: string
          victim_name: string | null
          victim_user_id: string | null
        }
        Insert: {
          admin_notes?: string | null
          archived_at?: string
          archived_by: string
          case_number: string
          connection_logs?: Json
          created_at?: string
          device_fingerprints?: Json
          id?: string
          ip_addresses?: string[]
          legal_complaint_date?: string | null
          legal_complaint_filed?: boolean
          legal_reference?: string | null
          profile_snapshot?: Json | null
          screenshots_urls?: string[]
          status?: string
          usurper_avatar_url?: string | null
          usurper_bio?: string | null
          usurper_email?: string | null
          usurper_name?: string | null
          usurper_user_id: string
          victim_name?: string | null
          victim_user_id?: string | null
        }
        Update: {
          admin_notes?: string | null
          archived_at?: string
          archived_by?: string
          case_number?: string
          connection_logs?: Json
          created_at?: string
          device_fingerprints?: Json
          id?: string
          ip_addresses?: string[]
          legal_complaint_date?: string | null
          legal_complaint_filed?: boolean
          legal_reference?: string | null
          profile_snapshot?: Json | null
          screenshots_urls?: string[]
          status?: string
          usurper_avatar_url?: string | null
          usurper_bio?: string | null
          usurper_email?: string | null
          usurper_name?: string | null
          usurper_user_id?: string
          victim_name?: string | null
          victim_user_id?: string | null
        }
        Relationships: []
      }
      identity_verifications: {
        Row: {
          admin_note: string | null
          auto_ban_email: boolean
          auto_ban_ip: boolean
          auto_deleted: boolean
          created_at: string
          deadline_at: string
          id: string
          id_document_url: string | null
          reason: string | null
          reported_email: string | null
          reported_ip: string | null
          reported_user_id: string
          reporter_id: string
          status: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          admin_note?: string | null
          auto_ban_email?: boolean
          auto_ban_ip?: boolean
          auto_deleted?: boolean
          created_at?: string
          deadline_at?: string
          id?: string
          id_document_url?: string | null
          reason?: string | null
          reported_email?: string | null
          reported_ip?: string | null
          reported_user_id: string
          reporter_id: string
          status?: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          admin_note?: string | null
          auto_ban_email?: boolean
          auto_ban_ip?: boolean
          auto_deleted?: boolean
          created_at?: string
          deadline_at?: string
          id?: string
          id_document_url?: string | null
          reason?: string | null
          reported_email?: string | null
          reported_ip?: string | null
          reported_user_id?: string
          reporter_id?: string
          status?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      invalid_e2ee_devices: {
        Row: {
          created_at: string
          device_id: string
          reason: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          reason?: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          reason?: string
          user_id?: string
        }
        Relationships: []
      }
      journal_entries: {
        Row: {
          body: string
          created_at: string
          id: string
          mood: string | null
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          mood?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          mood?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      likes: {
        Row: {
          created_at: string
          id: string
          post_id: string
          reaction_type: Database["public"]["Enums"]["reaction_type"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          post_id: string
          reaction_type?: Database["public"]["Enums"]["reaction_type"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          post_id?: string
          reaction_type?: Database["public"]["Enums"]["reaction_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      live_chat: {
        Row: {
          created_at: string
          gift_type: string | null
          id: string
          is_gift: boolean
          live_id: string
          message: string
          user_id: string
        }
        Insert: {
          created_at?: string
          gift_type?: string | null
          id?: string
          is_gift?: boolean
          live_id: string
          message: string
          user_id: string
        }
        Update: {
          created_at?: string
          gift_type?: string | null
          id?: string
          is_gift?: boolean
          live_id?: string
          message?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_chat_live_id_fkey"
            columns: ["live_id"]
            isOneToOne: false
            referencedRelation: "live_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      live_streams: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          ended_at: string | null
          hashtags: string[] | null
          id: string
          is_active: boolean
          peak_viewer_count: number
          recording_url: string | null
          started_at: string | null
          stream_key: string | null
          thumbnail_url: string | null
          title: string
          total_views: number
          user_id: string
          viewer_count: number
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          ended_at?: string | null
          hashtags?: string[] | null
          id?: string
          is_active?: boolean
          peak_viewer_count?: number
          recording_url?: string | null
          started_at?: string | null
          stream_key?: string | null
          thumbnail_url?: string | null
          title: string
          total_views?: number
          user_id: string
          viewer_count?: number
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          ended_at?: string | null
          hashtags?: string[] | null
          id?: string
          is_active?: boolean
          peak_viewer_count?: number
          recording_url?: string | null
          started_at?: string | null
          stream_key?: string | null
          thumbnail_url?: string | null
          title?: string
          total_views?: number
          user_id?: string
          viewer_count?: number
        }
        Relationships: []
      }
      live_views: {
        Row: {
          id: string
          joined_at: string
          left_at: string | null
          live_id: string
          user_id: string
          watch_time_seconds: number
        }
        Insert: {
          id?: string
          joined_at?: string
          left_at?: string | null
          live_id: string
          user_id: string
          watch_time_seconds?: number
        }
        Update: {
          id?: string
          joined_at?: string
          left_at?: string | null
          live_id?: string
          user_id?: string
          watch_time_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "live_views_live_id_fkey"
            columns: ["live_id"]
            isOneToOne: false
            referencedRelation: "live_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      login_alerts: {
        Row: {
          city: string | null
          country: string | null
          created_at: string
          device_hash: string
          email_sent: boolean
          id: string
          ip_address: string | null
          region: string | null
          resolved: string | null
          resolved_at: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string
          device_hash: string
          email_sent?: boolean
          id?: string
          ip_address?: string | null
          region?: string | null
          resolved?: string | null
          resolved_at?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string
          device_hash?: string
          email_sent?: boolean
          id?: string
          ip_address?: string | null
          region?: string | null
          resolved?: string | null
          resolved_at?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      login_attempts: {
        Row: {
          created_at: string
          email_hash: string | null
          id: string
          ip_address: string | null
          success: boolean
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          email_hash?: string | null
          id?: string
          ip_address?: string | null
          success: boolean
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          email_hash?: string | null
          id?: string
          ip_address?: string | null
          success?: boolean
          user_agent?: string | null
        }
        Relationships: []
      }
      message_archives: {
        Row: {
          archive_body: string
          created_at: string
          message_id: string
          user_id: string
        }
        Insert: {
          archive_body: string
          created_at?: string
          message_id: string
          user_id: string
        }
        Update: {
          archive_body?: string
          created_at?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_archives_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_deletions: {
        Row: {
          created_at: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_deletions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_device_copies: {
        Row: {
          created_at: string
          delivered_at: string | null
          encrypted_body: string
          id: string
          message_id: string
          read_at: string | null
          recipient_device_id: string
          recipient_user_id: string
          sender_device_id: string
          sender_user_id: string
        }
        Insert: {
          created_at?: string
          delivered_at?: string | null
          encrypted_body: string
          id?: string
          message_id: string
          read_at?: string | null
          recipient_device_id: string
          recipient_user_id: string
          sender_device_id: string
          sender_user_id: string
        }
        Update: {
          created_at?: string
          delivered_at?: string | null
          encrypted_body?: string
          id?: string
          message_id?: string
          read_at?: string | null
          recipient_device_id?: string
          recipient_user_id?: string
          sender_device_id?: string
          sender_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_device_copies_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_device_retry_requests: {
        Row: {
          attempt_count: number
          created_at: string
          id: string
          last_error: string | null
          message_id: string
          requester_device_id: string
          requester_user_id: string
          sender_user_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          id?: string
          last_error?: string | null
          message_id: string
          requester_device_id: string
          requester_user_id: string
          sender_user_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          id?: string
          last_error?: string | null
          message_id?: string
          requester_device_id?: string
          requester_user_id?: string
          sender_user_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_device_retry_requests_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      message_read_receipts: {
        Row: {
          conversation_id: string
          device_id: string
          message_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          device_id: string
          message_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          device_id?: string
          message_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          archive_body: string | null
          body: string
          body_kind: string
          conversation_id: string
          created_at: string
          document_mime: string | null
          document_name: string | null
          document_size_bytes: number | null
          document_url: string | null
          expires_at: string | null
          id: string
          image_url: string | null
          sender_id: string
          status: string
          view_once: boolean
          viewed_at: string | null
        }
        Insert: {
          archive_body?: string | null
          body: string
          body_kind?: string
          conversation_id: string
          created_at?: string
          document_mime?: string | null
          document_name?: string | null
          document_size_bytes?: number | null
          document_url?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          sender_id: string
          status?: string
          view_once?: boolean
          viewed_at?: string | null
        }
        Update: {
          archive_body?: string | null
          body?: string
          body_kind?: string
          conversation_id?: string
          created_at?: string
          document_mime?: string | null
          document_name?: string | null
          document_size_bytes?: number | null
          document_url?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          sender_id?: string
          status?: string
          view_once?: boolean
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      minor_contact_logs: {
        Row: {
          adult_user_id: string
          contact_type: string
          created_at: string
          id: string
          minor_user_id: string
        }
        Insert: {
          adult_user_id: string
          contact_type?: string
          created_at?: string
          id?: string
          minor_user_id: string
        }
        Update: {
          adult_user_id?: string
          contact_type?: string
          created_at?: string
          id?: string
          minor_user_id?: string
        }
        Relationships: []
      }
      ml_fraud_signals: {
        Row: {
          created_at: string
          details: Json | null
          id: string
          resolved: boolean | null
          resolved_at: string | null
          resolved_by: string | null
          risk_score: number
          signal_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          details?: Json | null
          id?: string
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          risk_score?: number
          signal_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          details?: Json | null
          id?: string
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          risk_score?: number
          signal_type?: string
          user_id?: string
        }
        Relationships: []
      }
      ml_interactions: {
        Row: {
          created_at: string
          day_of_week: number
          dwell_ms: number | null
          hour_of_day: number
          id: string
          is_weekend: boolean
          post_id: string
          scroll_depth: number | null
          signal_type: string
          user_id: string
          weight: number
        }
        Insert: {
          created_at?: string
          day_of_week?: number
          dwell_ms?: number | null
          hour_of_day?: number
          id?: string
          is_weekend?: boolean
          post_id: string
          scroll_depth?: number | null
          signal_type: string
          user_id: string
          weight?: number
        }
        Update: {
          created_at?: string
          day_of_week?: number
          dwell_ms?: number | null
          hour_of_day?: number
          id?: string
          is_weekend?: boolean
          post_id?: string
          scroll_depth?: number | null
          signal_type?: string
          user_id?: string
          weight?: number
        }
        Relationships: []
      }
      ml_model_config: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      ml_model_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          duration_ms: number | null
          error_message: string | null
          id: string
          interactions_analyzed: number | null
          metrics: Json | null
          posts_processed: number | null
          run_type: string
          started_at: string
          status: string
          users_processed: number | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          interactions_analyzed?: number | null
          metrics?: Json | null
          posts_processed?: number | null
          run_type?: string
          started_at?: string
          status?: string
          users_processed?: number | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          interactions_analyzed?: number | null
          metrics?: Json | null
          posts_processed?: number | null
          run_type?: string
          started_at?: string
          status?: string
          users_processed?: number | null
        }
        Relationships: []
      }
      ml_models: {
        Row: {
          accuracy: number | null
          config: Json | null
          created_at: string
          description: string | null
          domain: string
          f1_score: number | null
          id: string
          is_active: boolean | null
          name: string
          precision_score: number | null
          recall_score: number | null
          total_correct: number | null
          total_predictions: number | null
          updated_at: string
          version: string
        }
        Insert: {
          accuracy?: number | null
          config?: Json | null
          created_at?: string
          description?: string | null
          domain: string
          f1_score?: number | null
          id?: string
          is_active?: boolean | null
          name: string
          precision_score?: number | null
          recall_score?: number | null
          total_correct?: number | null
          total_predictions?: number | null
          updated_at?: string
          version?: string
        }
        Update: {
          accuracy?: number | null
          config?: Json | null
          created_at?: string
          description?: string | null
          domain?: string
          f1_score?: number | null
          id?: string
          is_active?: boolean | null
          name?: string
          precision_score?: number | null
          recall_score?: number | null
          total_correct?: number | null
          total_predictions?: number | null
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      ml_post_embeddings: {
        Row: {
          created_at: string
          embedding: string | null
          last_trained_at: string
          post_id: string
          training_samples: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          embedding?: string | null
          last_trained_at?: string
          post_id: string
          training_samples?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          embedding?: string | null
          last_trained_at?: string
          post_id?: string
          training_samples?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ml_post_embeddings_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: true
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ml_post_embeddings_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: true
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      ml_post_features: {
        Row: {
          avg_watch_time_ms: number | null
          ctr: number
          embedding: string | null
          embedding_updated_at: string | null
          engagement_score: number
          engagement_velocity: number
          extracted_at: string
          has_media: boolean
          hashtags: string[]
          language: string | null
          negative_count: number
          positive_count: number
          post_id: string
          quality_score: number
          revenue_score: number
          sentiment: number
          topics: string[]
          updated_at: string
          view_count: number
          watch_sample_count: number | null
          wellbeing_score: number
        }
        Insert: {
          avg_watch_time_ms?: number | null
          ctr?: number
          embedding?: string | null
          embedding_updated_at?: string | null
          engagement_score?: number
          engagement_velocity?: number
          extracted_at?: string
          has_media?: boolean
          hashtags?: string[]
          language?: string | null
          negative_count?: number
          positive_count?: number
          post_id: string
          quality_score?: number
          revenue_score?: number
          sentiment?: number
          topics?: string[]
          updated_at?: string
          view_count?: number
          watch_sample_count?: number | null
          wellbeing_score?: number
        }
        Update: {
          avg_watch_time_ms?: number | null
          ctr?: number
          embedding?: string | null
          embedding_updated_at?: string | null
          engagement_score?: number
          engagement_velocity?: number
          extracted_at?: string
          has_media?: boolean
          hashtags?: string[]
          language?: string | null
          negative_count?: number
          positive_count?: number
          post_id?: string
          quality_score?: number
          revenue_score?: number
          sentiment?: number
          topics?: string[]
          updated_at?: string
          view_count?: number
          watch_sample_count?: number | null
          wellbeing_score?: number
        }
        Relationships: []
      }
      ml_predictions: {
        Row: {
          confidence: number
          created_at: string
          domain: string
          id: string
          is_correct: boolean | null
          latency_ms: number | null
          model_id: string | null
          prediction: Json
          target_id: string | null
          target_type: string | null
          user_id: string | null
        }
        Insert: {
          confidence?: number
          created_at?: string
          domain: string
          id?: string
          is_correct?: boolean | null
          latency_ms?: number | null
          model_id?: string | null
          prediction: Json
          target_id?: string | null
          target_type?: string | null
          user_id?: string | null
        }
        Update: {
          confidence?: number
          created_at?: string
          domain?: string
          id?: string
          is_correct?: boolean | null
          latency_ms?: number | null
          model_id?: string | null
          prediction?: Json
          target_id?: string | null
          target_type?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ml_predictions_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "ml_models"
            referencedColumns: ["id"]
          },
        ]
      }
      ml_training_feedback: {
        Row: {
          corrected_label: string
          created_at: string
          domain: string
          feedback_source: string | null
          id: string
          original_label: string | null
          prediction_id: string | null
          reason: string | null
          reviewer_id: string | null
        }
        Insert: {
          corrected_label: string
          created_at?: string
          domain: string
          feedback_source?: string | null
          id?: string
          original_label?: string | null
          prediction_id?: string | null
          reason?: string | null
          reviewer_id?: string | null
        }
        Update: {
          corrected_label?: string
          created_at?: string
          domain?: string
          feedback_source?: string | null
          id?: string
          original_label?: string | null
          prediction_id?: string | null
          reason?: string | null
          reviewer_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ml_training_feedback_prediction_id_fkey"
            columns: ["prediction_id"]
            isOneToOne: false
            referencedRelation: "ml_predictions"
            referencedColumns: ["id"]
          },
        ]
      }
      ml_user_embeddings: {
        Row: {
          created_at: string
          embedding: string | null
          last_trained_at: string
          training_samples: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          embedding?: string | null
          last_trained_at?: string
          training_samples?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          embedding?: string | null
          last_trained_at?: string
          training_samples?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ml_user_profiles: {
        Row: {
          author_affinity: Json
          avg_dwell_ms: number | null
          avg_session_dwell_ms: number
          created_at: string
          daily_activity: Json
          embedding: string | null
          embedding_updated_at: string | null
          hashtag_weights: Json
          hourly_activity: Json
          last_trained_at: string | null
          preferred_content_length: string | null
          topic_weights: Json
          total_interactions: number
          updated_at: string
          user_id: string
        }
        Insert: {
          author_affinity?: Json
          avg_dwell_ms?: number | null
          avg_session_dwell_ms?: number
          created_at?: string
          daily_activity?: Json
          embedding?: string | null
          embedding_updated_at?: string | null
          hashtag_weights?: Json
          hourly_activity?: Json
          last_trained_at?: string | null
          preferred_content_length?: string | null
          topic_weights?: Json
          total_interactions?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          author_affinity?: Json
          avg_dwell_ms?: number | null
          avg_session_dwell_ms?: number
          created_at?: string
          daily_activity?: Json
          embedding?: string | null
          embedding_updated_at?: string | null
          hashtag_weights?: Json
          hourly_activity?: Json
          last_trained_at?: string | null
          preferred_content_length?: string | null
          topic_weights?: Json
          total_interactions?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      negotiations: {
        Row: {
          buyer_id: string
          conversation_id: string | null
          counter_price: number | null
          created_at: string | null
          id: string
          offered_price: number
          order_id: string | null
          original_price: number
          product_id: string
          seller_profile_id: string
          status: string
          updated_at: string | null
        }
        Insert: {
          buyer_id: string
          conversation_id?: string | null
          counter_price?: number | null
          created_at?: string | null
          id?: string
          offered_price: number
          order_id?: string | null
          original_price: number
          product_id: string
          seller_profile_id: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          buyer_id?: string
          conversation_id?: string | null
          counter_price?: number | null
          created_at?: string | null
          id?: string
          offered_price?: number
          order_id?: string | null
          original_price?: number
          product_id?: string
          seller_profile_id?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "negotiations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "negotiations_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "negotiations_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "negotiations_seller_profile_id_fkey"
            columns: ["seller_profile_id"]
            isOneToOne: false
            referencedRelation: "seller_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_settings: {
        Row: {
          close_friends_posts_enabled: boolean
          comments_enabled: boolean
          created_at: string
          email_notifications_enabled: boolean
          friend_requests_enabled: boolean
          id: string
          likes_enabled: boolean
          messages_enabled: boolean
          sound_enabled: boolean
          sound_type: string
          story_views_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          close_friends_posts_enabled?: boolean
          comments_enabled?: boolean
          created_at?: string
          email_notifications_enabled?: boolean
          friend_requests_enabled?: boolean
          id?: string
          likes_enabled?: boolean
          messages_enabled?: boolean
          sound_enabled?: boolean
          sound_type?: string
          story_views_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          close_friends_posts_enabled?: boolean
          comments_enabled?: boolean
          created_at?: string
          email_notifications_enabled?: boolean
          friend_requests_enabled?: boolean
          id?: string
          likes_enabled?: boolean
          messages_enabled?: boolean
          sound_enabled?: boolean
          sound_type?: string
          story_views_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          actor_id: string
          created_at: string
          id: string
          metadata: Json | null
          post_id: string | null
          read_at: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Insert: {
          actor_id: string
          created_at?: string
          id?: string
          metadata?: Json | null
          post_id?: string | null
          read_at?: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Update: {
          actor_id?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          post_id?: string | null
          read_at?: string | null
          type?: Database["public"]["Enums"]["notification_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          commission_amount: number
          created_at: string
          id: string
          order_id: string
          price: number
          product_id: string | null
          quantity: number
          seller_id: string
          seller_payout: number
          status: Database["public"]["Enums"]["order_status"]
          subtotal: number
          title: string
        }
        Insert: {
          commission_amount: number
          created_at?: string
          id?: string
          order_id: string
          price: number
          product_id?: string | null
          quantity?: number
          seller_id: string
          seller_payout: number
          status?: Database["public"]["Enums"]["order_status"]
          subtotal: number
          title: string
        }
        Update: {
          commission_amount?: number
          created_at?: string
          id?: string
          order_id?: string
          price?: number
          product_id?: string | null
          quantity?: number
          seller_id?: string
          seller_payout?: number
          status?: Database["public"]["Enums"]["order_status"]
          subtotal?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "seller_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          buyer_id: string
          cancelled_at: string | null
          commission_amount: number
          commission_rate: number
          created_at: string
          delivered_at: string | null
          id: string
          notes: string | null
          order_number: string
          packing_video_status: string
          packing_video_url: string | null
          paid_at: string | null
          payment_intent_id: string | null
          shipped_at: string | null
          shipping_address: Json | null
          shipping_label_url: string | null
          shipping_method: string | null
          shipping_relay_address: string | null
          shipping_relay_city: string | null
          shipping_relay_country: string | null
          shipping_relay_id: string | null
          shipping_relay_name: string | null
          shipping_relay_postcode: string | null
          shipping_weight_grams: number | null
          status: Database["public"]["Enums"]["order_status"]
          subtotal: number
          total: number
          tracking_number: string | null
          updated_at: string
        }
        Insert: {
          buyer_id: string
          cancelled_at?: string | null
          commission_amount: number
          commission_rate?: number
          created_at?: string
          delivered_at?: string | null
          id?: string
          notes?: string | null
          order_number: string
          packing_video_status?: string
          packing_video_url?: string | null
          paid_at?: string | null
          payment_intent_id?: string | null
          shipped_at?: string | null
          shipping_address?: Json | null
          shipping_label_url?: string | null
          shipping_method?: string | null
          shipping_relay_address?: string | null
          shipping_relay_city?: string | null
          shipping_relay_country?: string | null
          shipping_relay_id?: string | null
          shipping_relay_name?: string | null
          shipping_relay_postcode?: string | null
          shipping_weight_grams?: number | null
          status?: Database["public"]["Enums"]["order_status"]
          subtotal: number
          total: number
          tracking_number?: string | null
          updated_at?: string
        }
        Update: {
          buyer_id?: string
          cancelled_at?: string | null
          commission_amount?: number
          commission_rate?: number
          created_at?: string
          delivered_at?: string | null
          id?: string
          notes?: string | null
          order_number?: string
          packing_video_status?: string
          packing_video_url?: string | null
          paid_at?: string | null
          payment_intent_id?: string | null
          shipped_at?: string | null
          shipping_address?: Json | null
          shipping_label_url?: string | null
          shipping_method?: string | null
          shipping_relay_address?: string | null
          shipping_relay_city?: string | null
          shipping_relay_country?: string | null
          shipping_relay_id?: string | null
          shipping_relay_name?: string | null
          shipping_relay_postcode?: string | null
          shipping_weight_grams?: number | null
          status?: Database["public"]["Enums"]["order_status"]
          subtotal?: number
          total?: number
          tracking_number?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      page_admins: {
        Row: {
          added_at: string
          id: string
          page_id: string
          role: string
          user_id: string
        }
        Insert: {
          added_at?: string
          id?: string
          page_id: string
          role?: string
          user_id: string
        }
        Update: {
          added_at?: string
          id?: string
          page_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_admins_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      page_followers: {
        Row: {
          followed_at: string
          id: string
          page_id: string
          user_id: string
        }
        Insert: {
          followed_at?: string
          id?: string
          page_id: string
          user_id: string
        }
        Update: {
          followed_at?: string
          id?: string
          page_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_followers_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      page_posts: {
        Row: {
          body: string
          created_at: string
          id: string
          image_url: string | null
          page_id: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          image_url?: string | null
          page_id: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          image_url?: string | null
          page_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "page_posts_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      pages: {
        Row: {
          address: string | null
          category: string
          cover_image_url: string | null
          created_at: string
          created_by: string
          description: string | null
          email: string | null
          id: string
          name: string
          phone: string | null
          profile_image_url: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          address?: string | null
          category?: string
          cover_image_url?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          profile_image_url?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          address?: string | null
          category?: string
          cover_image_url?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          profile_image_url?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: []
      }
      parental_controls: {
        Row: {
          allowed_categories: string[]
          created_at: string
          id: string
          is_active: boolean
          is_minor: boolean
          pin_hash: string
          updated_at: string
          user_id: string
        }
        Insert: {
          allowed_categories?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          is_minor?: boolean
          pin_hash: string
          updated_at?: string
          user_id: string
        }
        Update: {
          allowed_categories?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          is_minor?: boolean
          pin_hash?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      post_views: {
        Row: {
          id: string
          post_id: string
          user_id: string
          viewed_at: string
        }
        Insert: {
          id?: string
          post_id: string
          user_id: string
          viewed_at?: string
        }
        Update: {
          id?: string
          post_id?: string
          user_id?: string
          viewed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_views_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_views_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          body: string
          comments_count: number
          created_at: string
          expires_at: string | null
          id: string
          image_url: string | null
          likes_count: number
          publish_at: string | null
          user_id: string
        }
        Insert: {
          body: string
          comments_count?: number
          created_at?: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          likes_count?: number
          publish_at?: string | null
          user_id: string
        }
        Update: {
          body?: string
          comments_count?: number
          created_at?: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          likes_count?: number
          publish_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      privacy_settings: {
        Row: {
          ai_data_sharing_enabled: boolean
          ai_personalization_enabled: boolean
          analytics_enabled: boolean
          comments_allowed: string
          created_at: string
          daily_limit_minutes: number | null
          detox_schedule: Json | null
          friends_list_visibility: string
          ghost_mode: boolean
          id: string
          likes_visibility: string
          messages_allowed: string
          online_status_visibility: string
          posts_visibility: string
          profile_visibility: string
          search_engine_indexing: boolean
          updated_at: string
          user_id: string
          wall_visibility: string
        }
        Insert: {
          ai_data_sharing_enabled?: boolean
          ai_personalization_enabled?: boolean
          analytics_enabled?: boolean
          comments_allowed?: string
          created_at?: string
          daily_limit_minutes?: number | null
          detox_schedule?: Json | null
          friends_list_visibility?: string
          ghost_mode?: boolean
          id?: string
          likes_visibility?: string
          messages_allowed?: string
          online_status_visibility?: string
          posts_visibility?: string
          profile_visibility?: string
          search_engine_indexing?: boolean
          updated_at?: string
          user_id: string
          wall_visibility?: string
        }
        Update: {
          ai_data_sharing_enabled?: boolean
          ai_personalization_enabled?: boolean
          analytics_enabled?: boolean
          comments_allowed?: string
          created_at?: string
          daily_limit_minutes?: number | null
          detox_schedule?: Json | null
          friends_list_visibility?: string
          ghost_mode?: boolean
          id?: string
          likes_visibility?: string
          messages_allowed?: string
          online_status_visibility?: string
          posts_visibility?: string
          profile_visibility?: string
          search_engine_indexing?: boolean
          updated_at?: string
          user_id?: string
          wall_visibility?: string
        }
        Relationships: []
      }
      product_favorites: {
        Row: {
          created_at: string
          id: string
          product_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_favorites_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_reviews: {
        Row: {
          body: string | null
          created_at: string
          helpful_count: number
          id: string
          images: string[] | null
          is_verified_purchase: boolean
          order_item_id: string | null
          product_id: string
          rating: number
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          helpful_count?: number
          id?: string
          images?: string[] | null
          is_verified_purchase?: boolean
          order_item_id?: string | null
          product_id: string
          rating: number
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          helpful_count?: number
          id?: string
          images?: string[] | null
          is_verified_purchase?: boolean
          order_item_id?: string | null
          product_id?: string
          rating?: number
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_reviews_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_reviews_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          category: string
          city: string | null
          color: string | null
          compare_at_price: number | null
          condition: string | null
          country: string | null
          created_at: string
          description: string | null
          digital_file_url: string | null
          id: string
          images: string[] | null
          is_active: boolean
          is_featured: boolean
          order_count: number
          price: number
          product_type: Database["public"]["Enums"]["product_type"]
          rating_average: number | null
          rating_count: number
          region: string | null
          seller_id: string
          shipping_price: number | null
          shipping_type: string
          size: string | null
          stock_quantity: number | null
          tags: string[] | null
          thumbnail_url: string | null
          title: string
          updated_at: string
          view_count: number
          weight_grams: number | null
        }
        Insert: {
          category?: string
          city?: string | null
          color?: string | null
          compare_at_price?: number | null
          condition?: string | null
          country?: string | null
          created_at?: string
          description?: string | null
          digital_file_url?: string | null
          id?: string
          images?: string[] | null
          is_active?: boolean
          is_featured?: boolean
          order_count?: number
          price: number
          product_type?: Database["public"]["Enums"]["product_type"]
          rating_average?: number | null
          rating_count?: number
          region?: string | null
          seller_id: string
          shipping_price?: number | null
          shipping_type?: string
          size?: string | null
          stock_quantity?: number | null
          tags?: string[] | null
          thumbnail_url?: string | null
          title: string
          updated_at?: string
          view_count?: number
          weight_grams?: number | null
        }
        Update: {
          category?: string
          city?: string | null
          color?: string | null
          compare_at_price?: number | null
          condition?: string | null
          country?: string | null
          created_at?: string
          description?: string | null
          digital_file_url?: string | null
          id?: string
          images?: string[] | null
          is_active?: boolean
          is_featured?: boolean
          order_count?: number
          price?: number
          product_type?: Database["public"]["Enums"]["product_type"]
          rating_average?: number | null
          rating_count?: number
          region?: string | null
          seller_id?: string
          shipping_price?: number | null
          shipping_type?: string
          size?: string | null
          stock_quantity?: number | null
          tags?: string[] | null
          thumbnail_url?: string | null
          title?: string
          updated_at?: string
          view_count?: number
          weight_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "products_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "seller_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          age_verification_status: string
          age_verified: boolean
          avatar_url: string | null
          bio: string | null
          city: string | null
          cover_position_y: number | null
          cover_url: string | null
          created_at: string
          creator_since: string | null
          creator_tier: string | null
          date_of_birth: string | null
          education_city: string | null
          education_level: string | null
          feed_bg_url: string | null
          field_visibility: Json | null
          id: string
          interests: string[] | null
          is_creator: boolean
          mood_emoji: string | null
          mood_text: string | null
          mood_updated_at: string | null
          name: string
          onboarding_completed: boolean
          onboarding_step: number
          phone_number: string | null
          profile_bg_url: string | null
          profile_music_url: string | null
          profile_type: string | null
          relationship_status: string | null
          updated_at: string
          user_id: string
          website_url: string | null
          work: string | null
        }
        Insert: {
          age_verification_status?: string
          age_verified?: boolean
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          cover_position_y?: number | null
          cover_url?: string | null
          created_at?: string
          creator_since?: string | null
          creator_tier?: string | null
          date_of_birth?: string | null
          education_city?: string | null
          education_level?: string | null
          feed_bg_url?: string | null
          field_visibility?: Json | null
          id?: string
          interests?: string[] | null
          is_creator?: boolean
          mood_emoji?: string | null
          mood_text?: string | null
          mood_updated_at?: string | null
          name: string
          onboarding_completed?: boolean
          onboarding_step?: number
          phone_number?: string | null
          profile_bg_url?: string | null
          profile_music_url?: string | null
          profile_type?: string | null
          relationship_status?: string | null
          updated_at?: string
          user_id: string
          website_url?: string | null
          work?: string | null
        }
        Update: {
          age_verification_status?: string
          age_verified?: boolean
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          cover_position_y?: number | null
          cover_url?: string | null
          created_at?: string
          creator_since?: string | null
          creator_tier?: string | null
          date_of_birth?: string | null
          education_city?: string | null
          education_level?: string | null
          feed_bg_url?: string | null
          field_visibility?: Json | null
          id?: string
          interests?: string[] | null
          is_creator?: boolean
          mood_emoji?: string | null
          mood_text?: string | null
          mood_updated_at?: string | null
          name?: string
          onboarding_completed?: boolean
          onboarding_step?: number
          phone_number?: string | null
          profile_bg_url?: string | null
          profile_music_url?: string | null
          profile_type?: string | null
          relationship_status?: string | null
          updated_at?: string
          user_id?: string
          website_url?: string | null
          work?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          p256dh: string
          updated_at: string
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh: string
          updated_at?: string
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      quality_events: {
        Row: {
          author_id: string | null
          content_id: string
          created_at: string
          event_type: string
          id: number
          is_ios: boolean
          metadata: Json
          session_id: string
          surface: string
          user_id: string | null
          value: number
        }
        Insert: {
          author_id?: string | null
          content_id: string
          created_at?: string
          event_type: string
          id?: number
          is_ios?: boolean
          metadata?: Json
          session_id: string
          surface: string
          user_id?: string | null
          value?: number
        }
        Update: {
          author_id?: string | null
          content_id?: string
          created_at?: string
          event_type?: string
          id?: number
          is_ios?: boolean
          metadata?: Json
          session_id?: string
          surface?: string
          user_id?: string | null
          value?: number
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          action_count: number
          action_type: string
          created_at: string
          id: string
          is_blocked: boolean
          user_id: string
          window_end: string
          window_start: string
        }
        Insert: {
          action_count?: number
          action_type: string
          created_at?: string
          id?: string
          is_blocked?: boolean
          user_id: string
          window_end?: string
          window_start?: string
        }
        Update: {
          action_count?: number
          action_type?: string
          created_at?: string
          id?: string
          is_blocked?: boolean
          user_id?: string
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      restricted_friends: {
        Row: {
          created_at: string
          id: string
          restrict_feed: boolean
          restrict_messages: boolean
          restrict_profile: boolean
          restrict_stories: boolean
          restricted_user_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          restrict_feed?: boolean
          restrict_messages?: boolean
          restrict_profile?: boolean
          restrict_stories?: boolean
          restricted_user_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          restrict_feed?: boolean
          restrict_messages?: boolean
          restrict_profile?: boolean
          restrict_stories?: boolean
          restricted_user_id?: string
          user_id?: string
        }
        Relationships: []
      }
      sealed_delivery_tokens: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          recipient_user_id: string
          token_hash: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          recipient_user_id: string
          token_hash: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          recipient_user_id?: string
          token_hash?: string
        }
        Relationships: []
      }
      sealed_sender_events: {
        Row: {
          anonymous_sender_tag: string
          conversation_id: string
          created_at: string
          id: number
          recipient_user_id: string | null
          sender_hint_hash: string | null
        }
        Insert: {
          anonymous_sender_tag: string
          conversation_id: string
          created_at?: string
          id?: number
          recipient_user_id?: string | null
          sender_hint_hash?: string | null
        }
        Update: {
          anonymous_sender_tag?: string
          conversation_id?: string
          created_at?: string
          id?: number
          recipient_user_id?: string | null
          sender_hint_hash?: string | null
        }
        Relationships: []
      }
      sealed_sender_messages: {
        Row: {
          anonymous_sender_tag: string
          conversation_id: string
          created_at: string
          delivered_at: string | null
          delivery_state: string
          id: string
          read_at: string | null
          recipient_user_id: string
          sealed_header: Json
          sealed_payload: string
        }
        Insert: {
          anonymous_sender_tag: string
          conversation_id: string
          created_at?: string
          delivered_at?: string | null
          delivery_state?: string
          id?: string
          read_at?: string | null
          recipient_user_id: string
          sealed_header?: Json
          sealed_payload: string
        }
        Update: {
          anonymous_sender_tag?: string
          conversation_id?: string
          created_at?: string
          delivered_at?: string | null
          delivery_state?: string
          id?: string
          read_at?: string | null
          recipient_user_id?: string
          sealed_header?: Json
          sealed_payload?: string
        }
        Relationships: []
      }
      security_ai_patterns: {
        Row: {
          autonomy_level: number | null
          avg_reaction_ms: number | null
          confidence: number
          confirmed_count: number | null
          created_at: string
          detection_rule: string
          false_positive_count: number | null
          id: string
          is_active: boolean
          last_matched_at: string | null
          pattern_name: string
          pattern_signature: Json
          severity: string
          source: string
          times_matched: number
          updated_at: string
        }
        Insert: {
          autonomy_level?: number | null
          avg_reaction_ms?: number | null
          confidence?: number
          confirmed_count?: number | null
          created_at?: string
          detection_rule: string
          false_positive_count?: number | null
          id?: string
          is_active?: boolean
          last_matched_at?: string | null
          pattern_name: string
          pattern_signature?: Json
          severity?: string
          source?: string
          times_matched?: number
          updated_at?: string
        }
        Update: {
          autonomy_level?: number | null
          avg_reaction_ms?: number | null
          confidence?: number
          confirmed_count?: number | null
          created_at?: string
          detection_rule?: string
          false_positive_count?: number | null
          id?: string
          is_active?: boolean
          last_matched_at?: string | null
          pattern_name?: string
          pattern_signature?: Json
          severity?: string
          source?: string
          times_matched?: number
          updated_at?: string
        }
        Relationships: []
      }
      security_alert_config: {
        Row: {
          alert_email: string
          created_at: string
          id: string
          is_active: boolean
          min_severity: string
        }
        Insert: {
          alert_email: string
          created_at?: string
          id?: string
          is_active?: boolean
          min_severity?: string
        }
        Update: {
          alert_email?: string
          created_at?: string
          id?: string
          is_active?: boolean
          min_severity?: string
        }
        Relationships: []
      }
      security_auto_mitigations: {
        Row: {
          action_result: Json | null
          autonomy_level: number | null
          confidence_score: number | null
          created_at: string
          id: string
          incident_id: string | null
          mitigation_type: string
          reason: string
          severity: string | null
          source_ip: string | null
        }
        Insert: {
          action_result?: Json | null
          autonomy_level?: number | null
          confidence_score?: number | null
          created_at?: string
          id?: string
          incident_id?: string | null
          mitigation_type: string
          reason: string
          severity?: string | null
          source_ip?: string | null
        }
        Update: {
          action_result?: Json | null
          autonomy_level?: number | null
          confidence_score?: number | null
          created_at?: string
          id?: string
          incident_id?: string | null
          mitigation_type?: string
          reason?: string
          severity?: string | null
          source_ip?: string | null
        }
        Relationships: []
      }
      security_incidents: {
        Row: {
          ai_analysis: string | null
          ai_recommendation: string | null
          alert_sent: boolean
          attack_vector: string | null
          autonomy_level: number | null
          confidence_factors: Json | null
          confidence_score: number | null
          created_at: string
          detection_source: string | null
          human_verified: boolean | null
          id: string
          incident_type: string
          raw_data: Json | null
          resolved_at: string | null
          severity: string
          source_ip: string | null
          status: string
          success: boolean
          target_endpoint: string | null
          vulnerability_found: string | null
          was_false_positive: boolean | null
        }
        Insert: {
          ai_analysis?: string | null
          ai_recommendation?: string | null
          alert_sent?: boolean
          attack_vector?: string | null
          autonomy_level?: number | null
          confidence_factors?: Json | null
          confidence_score?: number | null
          created_at?: string
          detection_source?: string | null
          human_verified?: boolean | null
          id?: string
          incident_type?: string
          raw_data?: Json | null
          resolved_at?: string | null
          severity?: string
          source_ip?: string | null
          status?: string
          success?: boolean
          target_endpoint?: string | null
          vulnerability_found?: string | null
          was_false_positive?: boolean | null
        }
        Update: {
          ai_analysis?: string | null
          ai_recommendation?: string | null
          alert_sent?: boolean
          attack_vector?: string | null
          autonomy_level?: number | null
          confidence_factors?: Json | null
          confidence_score?: number | null
          created_at?: string
          detection_source?: string | null
          human_verified?: boolean | null
          id?: string
          incident_type?: string
          raw_data?: Json | null
          resolved_at?: string | null
          severity?: string
          source_ip?: string | null
          status?: string
          success?: boolean
          target_endpoint?: string | null
          vulnerability_found?: string | null
          was_false_positive?: boolean | null
        }
        Relationships: []
      }
      security_logs: {
        Row: {
          created_at: string
          details: Json | null
          event_type: string
          id: string
          ip_address: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          details?: Json | null
          event_type: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          details?: Json | null
          event_type?: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      security_quality_metrics: {
        Row: {
          ai_cost_saved: boolean | null
          ai_detections: number | null
          autonomy_level: number | null
          autonomy_score: number | null
          confirmed_threats: number | null
          created_at: string
          detection_rate: number | null
          false_negatives: number | null
          false_positives: number | null
          gemini_calls: number | null
          id: string
          local_detections: number | null
          metadata: Json | null
          patterns_learned: number | null
          patterns_used: number | null
          reaction_time_ms: number | null
          scan_id: string
          total_incidents: number | null
        }
        Insert: {
          ai_cost_saved?: boolean | null
          ai_detections?: number | null
          autonomy_level?: number | null
          autonomy_score?: number | null
          confirmed_threats?: number | null
          created_at?: string
          detection_rate?: number | null
          false_negatives?: number | null
          false_positives?: number | null
          gemini_calls?: number | null
          id?: string
          local_detections?: number | null
          metadata?: Json | null
          patterns_learned?: number | null
          patterns_used?: number | null
          reaction_time_ms?: number | null
          scan_id: string
          total_incidents?: number | null
        }
        Update: {
          ai_cost_saved?: boolean | null
          ai_detections?: number | null
          autonomy_level?: number | null
          autonomy_score?: number | null
          confirmed_threats?: number | null
          created_at?: string
          detection_rate?: number | null
          false_negatives?: number | null
          false_positives?: number | null
          gemini_calls?: number | null
          id?: string
          local_detections?: number | null
          metadata?: Json | null
          patterns_learned?: number | null
          patterns_used?: number | null
          reaction_time_ms?: number | null
          scan_id?: string
          total_incidents?: number | null
        }
        Relationships: []
      }
      seller_payouts: {
        Row: {
          amount: number
          created_at: string
          id: string
          notes: string | null
          order_item_id: string | null
          paid_at: string | null
          seller_id: string
          status: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          notes?: string | null
          order_item_id?: string | null
          paid_at?: string | null
          seller_id: string
          status?: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          notes?: string | null
          order_item_id?: string | null
          paid_at?: string | null
          seller_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "seller_payouts_order_item_id_fkey"
            columns: ["order_item_id"]
            isOneToOne: false
            referencedRelation: "order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seller_payouts_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "seller_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      seller_profiles: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          is_verified: boolean
          rating_average: number | null
          rating_count: number
          store_banner_url: string | null
          store_description: string | null
          store_logo_url: string | null
          store_name: string
          total_revenue: number
          total_sales: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_verified?: boolean
          rating_average?: number | null
          rating_count?: number
          store_banner_url?: string | null
          store_description?: string | null
          store_logo_url?: string | null
          store_name: string
          total_revenue?: number
          total_sales?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_verified?: boolean
          rating_average?: number | null
          rating_count?: number
          store_banner_url?: string | null
          store_description?: string | null
          store_logo_url?: string | null
          store_name?: string
          total_revenue?: number
          total_sales?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      seller_reviews: {
        Row: {
          body: string | null
          created_at: string
          id: string
          order_id: string | null
          rating: number
          seller_id: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          order_id?: string | null
          rating: number
          seller_id: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          order_id?: string | null
          rating?: number
          seller_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seller_reviews_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seller_reviews_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "seller_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      sender_key_distribution: {
        Row: {
          conversation_id: string
          created_at: string
          delivered: boolean
          encrypted_skdm: string
          id: string
          recipient_device_id: string
          recipient_user_id: string
          sender_device_id: string
          sender_user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          delivered?: boolean
          encrypted_skdm: string
          id?: string
          recipient_device_id: string
          recipient_user_id: string
          sender_device_id: string
          sender_user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          delivered?: boolean
          encrypted_skdm?: string
          id?: string
          recipient_device_id?: string
          recipient_user_id?: string
          sender_device_id?: string
          sender_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sender_key_distribution_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      sender_key_state: {
        Row: {
          chain_key_b64: string | null
          conversation_id: string
          created_at: string
          id: string
          is_owner: boolean
          iteration: number
          sender_device_id: string
          sender_user_id: string
          signing_priv_jwk: Json | null
          signing_pub_b64: string
          updated_at: string
        }
        Insert: {
          chain_key_b64?: string | null
          conversation_id: string
          created_at?: string
          id?: string
          is_owner?: boolean
          iteration?: number
          sender_device_id: string
          sender_user_id: string
          signing_priv_jwk?: Json | null
          signing_pub_b64: string
          updated_at?: string
        }
        Update: {
          chain_key_b64?: string | null
          conversation_id?: string
          created_at?: string
          id?: string
          is_owner?: boolean
          iteration?: number
          sender_device_id?: string
          sender_user_id?: string
          signing_priv_jwk?: Json | null
          signing_pub_b64?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sender_key_state_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      short_videos: {
        Row: {
          caption: string | null
          comment_count: number
          created_at: string
          duration_seconds: number
          hashtags: string[] | null
          id: string
          is_public: boolean
          like_count: number
          share_count: number
          sound_id: string | null
          sound_name: string | null
          thumbnail_url: string | null
          updated_at: string
          user_id: string
          video_url: string
          view_count: number
        }
        Insert: {
          caption?: string | null
          comment_count?: number
          created_at?: string
          duration_seconds?: number
          hashtags?: string[] | null
          id?: string
          is_public?: boolean
          like_count?: number
          share_count?: number
          sound_id?: string | null
          sound_name?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id: string
          video_url: string
          view_count?: number
        }
        Update: {
          caption?: string | null
          comment_count?: number
          created_at?: string
          duration_seconds?: number
          hashtags?: string[] | null
          id?: string
          is_public?: boolean
          like_count?: number
          share_count?: number
          sound_id?: string | null
          sound_name?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string
          video_url?: string
          view_count?: number
        }
        Relationships: []
      }
      signed_device_lists: {
        Row: {
          created_at: string
          device_ids: string[]
          list_version: number
          signature: string | null
          signer_device_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_ids?: string[]
          list_version?: number
          signature?: string | null
          signer_device_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_ids?: string[]
          list_version?: number
          signature?: string | null
          signer_device_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      stories: {
        Row: {
          caption: string | null
          created_at: string
          expires_at: string
          id: string
          image_url: string
          user_id: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          image_url: string
          user_id: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          image_url?: string
          user_id?: string
        }
        Relationships: []
      }
      story_likes: {
        Row: {
          created_at: string
          id: string
          story_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          story_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          story_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_likes_story_id_fkey"
            columns: ["story_id"]
            isOneToOne: false
            referencedRelation: "stories"
            referencedColumns: ["id"]
          },
        ]
      }
      story_views: {
        Row: {
          id: string
          story_id: string
          viewed_at: string
          viewer_id: string
        }
        Insert: {
          id?: string
          story_id: string
          viewed_at?: string
          viewer_id: string
        }
        Update: {
          id?: string
          story_id?: string
          viewed_at?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_views_story_id_fkey"
            columns: ["story_id"]
            isOneToOne: false
            referencedRelation: "stories"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_processed_events: {
        Row: {
          event_id: string
          event_type: string
          processed_at: string
        }
        Insert: {
          event_id: string
          event_type: string
          processed_at?: string
        }
        Update: {
          event_id?: string
          event_type?: string
          processed_at?: string
        }
        Relationships: []
      }
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
      }
      threat_decisions: {
        Row: {
          action_taken: string
          category: string
          confidence: number
          created_at: string
          decided_by: string | null
          detector: string
          endpoint: string
          id: string
          ip: string | null
          payload_hash: string | null
          reason: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action_taken: string
          category: string
          confidence: number
          created_at?: string
          decided_by?: string | null
          detector: string
          endpoint: string
          id?: string
          ip?: string | null
          payload_hash?: string | null
          reason?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action_taken?: string
          category?: string
          confidence?: number
          created_at?: string
          decided_by?: string | null
          detector?: string
          endpoint?: string
          id?: string
          ip?: string | null
          payload_hash?: string | null
          reason?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      threat_model_weights: {
        Row: {
          accuracy: number | null
          active: boolean
          bias: number
          f1: number | null
          id: string
          notes: string | null
          precision_score: number | null
          recall: number | null
          samples_used: number
          trained_at: string
          version: number
          weights: Json
        }
        Insert: {
          accuracy?: number | null
          active?: boolean
          bias?: number
          f1?: number | null
          id?: string
          notes?: string | null
          precision_score?: number | null
          recall?: number | null
          samples_used?: number
          trained_at?: string
          version: number
          weights: Json
        }
        Update: {
          accuracy?: number | null
          active?: boolean
          bias?: number
          f1?: number | null
          id?: string
          notes?: string | null
          precision_score?: number | null
          recall?: number | null
          samples_used?: number
          trained_at?: string
          version?: number
          weights?: Json
        }
        Relationships: []
      }
      threat_training_samples: {
        Row: {
          category: string | null
          created_at: string
          endpoint: string | null
          features: Json
          id: string
          label: number
          source: string
          used_in_version: number | null
          weight: number
        }
        Insert: {
          category?: string | null
          created_at?: string
          endpoint?: string | null
          features: Json
          id?: string
          label: number
          source: string
          used_in_version?: number | null
          weight?: number
        }
        Update: {
          category?: string | null
          created_at?: string
          endpoint?: string | null
          features?: Json
          id?: string
          label?: number
          source?: string
          used_in_version?: number | null
          weight?: number
        }
        Relationships: []
      }
      tips: {
        Row: {
          amount: number
          commission_amount: number
          commission_rate: number
          created_at: string
          creator_id: string
          creator_payout: number
          id: string
          message: string | null
          status: string
          stripe_session_id: string | null
          tipper_id: string
        }
        Insert: {
          amount: number
          commission_amount: number
          commission_rate?: number
          created_at?: string
          creator_id: string
          creator_payout: number
          id?: string
          message?: string | null
          status?: string
          stripe_session_id?: string | null
          tipper_id: string
        }
        Update: {
          amount?: number
          commission_amount?: number
          commission_rate?: number
          created_at?: string
          creator_id?: string
          creator_payout?: number
          id?: string
          message?: string | null
          status?: string
          stripe_session_id?: string | null
          tipper_id?: string
        }
        Relationships: []
      }
      trust_scores: {
        Row: {
          account_age_score: number
          created_at: string
          disputes_lost: number
          disputes_opened: number
          flag_reason: string | null
          id: string
          is_flagged: boolean
          is_verified_identity: boolean
          reports_confirmed: number
          reports_received: number
          social_score: number
          successful_purchases: number
          successful_sales: number
          transaction_score: number
          trust_score: number
          updated_at: string
          user_id: string
          verification_score: number
        }
        Insert: {
          account_age_score?: number
          created_at?: string
          disputes_lost?: number
          disputes_opened?: number
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean
          is_verified_identity?: boolean
          reports_confirmed?: number
          reports_received?: number
          social_score?: number
          successful_purchases?: number
          successful_sales?: number
          transaction_score?: number
          trust_score?: number
          updated_at?: string
          user_id: string
          verification_score?: number
        }
        Update: {
          account_age_score?: number
          created_at?: string
          disputes_lost?: number
          disputes_opened?: number
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean
          is_verified_identity?: boolean
          reports_confirmed?: number
          reports_received?: number
          social_score?: number
          successful_purchases?: number
          successful_sales?: number
          transaction_score?: number
          trust_score?: number
          updated_at?: string
          user_id?: string
          verification_score?: number
        }
        Relationships: []
      }
      tv_channels: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          theme: string
          thumbnail_url: string | null
          updated_at: string
          user_id: string
          viewer_count: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          theme?: string
          thumbnail_url?: string | null
          updated_at?: string
          user_id: string
          viewer_count?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          theme?: string
          thumbnail_url?: string | null
          updated_at?: string
          user_id?: string
          viewer_count?: number
        }
        Relationships: []
      }
      user_backups: {
        Row: {
          backup_type: string
          created_at: string
          encrypted_blob: string
          id: string
          iv: string
          master_key_iv: string | null
          mk_attempts_count: number
          mk_attempts_window_start: string | null
          mk_locked_until: string | null
          salt: string
          user_id: string
          version: number
          wrapped_master_key: string | null
        }
        Insert: {
          backup_type?: string
          created_at?: string
          encrypted_blob: string
          id?: string
          iv: string
          master_key_iv?: string | null
          mk_attempts_count?: number
          mk_attempts_window_start?: string | null
          mk_locked_until?: string | null
          salt: string
          user_id: string
          version?: number
          wrapped_master_key?: string | null
        }
        Update: {
          backup_type?: string
          created_at?: string
          encrypted_blob?: string
          id?: string
          iv?: string
          master_key_iv?: string | null
          mk_attempts_count?: number
          mk_attempts_window_start?: string | null
          mk_locked_until?: string | null
          salt?: string
          user_id?: string
          version?: number
          wrapped_master_key?: string | null
        }
        Relationships: []
      }
      user_behavior_signals: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          post_id: string
          signal_type: string
          user_id: string
          value: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          post_id: string
          signal_type: string
          user_id: string
          value?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          post_id?: string
          signal_type?: string
          user_id?: string
          value?: number | null
        }
        Relationships: []
      }
      user_chat_pins: {
        Row: {
          created_at: string
          failed_attempts: number | null
          id: string
          locked_until: string | null
          pin_hash: string
          pin_mode: string
          reset_code_expires: string | null
          reset_code_hash: string | null
          reset_code_salt: string | null
          salt: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          failed_attempts?: number | null
          id?: string
          locked_until?: string | null
          pin_hash: string
          pin_mode?: string
          reset_code_expires?: string | null
          reset_code_hash?: string | null
          reset_code_salt?: string | null
          salt: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          failed_attempts?: number | null
          id?: string
          locked_until?: string | null
          pin_hash?: string
          pin_mode?: string
          reset_code_expires?: string | null
          reset_code_hash?: string | null
          reset_code_salt?: string | null
          salt?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_crypto_state: {
        Row: {
          client_key_published_at: string | null
          created_at: string
          fingerprint: string | null
          identity_epoch: number
          key_slot_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          client_key_published_at?: string | null
          created_at?: string
          fingerprint?: string | null
          identity_epoch?: number
          key_slot_id?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          client_key_published_at?: string | null
          created_at?: string
          fingerprint?: string | null
          identity_epoch?: number
          key_slot_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_device_signatures: {
        Row: {
          device_id: string
          id: string
          primary_device_id: string
          primary_pub_b64: string
          revoked_at: string | null
          signature_b64: string
          signed_at: string
          user_id: string
        }
        Insert: {
          device_id: string
          id?: string
          primary_device_id: string
          primary_pub_b64: string
          revoked_at?: string | null
          signature_b64: string
          signed_at?: string
          user_id: string
        }
        Update: {
          device_id?: string
          id?: string
          primary_device_id?: string
          primary_pub_b64?: string
          revoked_at?: string | null
          signature_b64?: string
          signed_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_devices: {
        Row: {
          approval_email_sent_at: string | null
          approval_requested_at: string | null
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          created_at: string
          crypto_invalid_at: string | null
          crypto_invalid_reason: string | null
          device_fingerprint: string | null
          device_id: string
          device_name: string | null
          device_public_key: string
          id: string
          is_active: boolean
          is_primary: boolean
          last_seen_at: string
          platform: string | null
          prekey_repair_requested_at: string | null
          rejected_at: string | null
          rejected_by: string | null
          revoke_reason: string | null
          revoked_at: string | null
          stale_at: string | null
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          approval_email_sent_at?: string | null
          approval_requested_at?: string | null
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          crypto_invalid_at?: string | null
          crypto_invalid_reason?: string | null
          device_fingerprint?: string | null
          device_id: string
          device_name?: string | null
          device_public_key: string
          id?: string
          is_active?: boolean
          is_primary?: boolean
          last_seen_at?: string
          platform?: string | null
          prekey_repair_requested_at?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          stale_at?: string | null
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          approval_email_sent_at?: string | null
          approval_requested_at?: string | null
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          crypto_invalid_at?: string | null
          crypto_invalid_reason?: string | null
          device_fingerprint?: string | null
          device_id?: string
          device_name?: string | null
          device_public_key?: string
          id?: string
          is_active?: boolean
          is_primary?: boolean
          last_seen_at?: string
          platform?: string | null
          prekey_repair_requested_at?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          revoke_reason?: string | null
          revoked_at?: string | null
          stale_at?: string | null
          updated_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_feed: {
        Row: {
          inserted_at: string
          post_id: string
          score: number
          user_id: string
        }
        Insert: {
          inserted_at?: string
          post_id: string
          score?: number
          user_id: string
        }
        Update: {
          inserted_at?: string
          post_id?: string
          score?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_feed_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "feed_posts_enriched"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_feed_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_feed_preferences: {
        Row: {
          created_at: string
          diversity_boost: number
          feed_algorithm: string
          muted_keywords: string[]
          priority_topics: string[]
          seen_posts_hide: boolean
          sensitive_content_filter: boolean
          updated_at: string
          user_id: string
          viral_content_reduce: boolean
          weight_discovery: number
          weight_friends: number
          weight_marketplace: number
        }
        Insert: {
          created_at?: string
          diversity_boost?: number
          feed_algorithm?: string
          muted_keywords?: string[]
          priority_topics?: string[]
          seen_posts_hide?: boolean
          sensitive_content_filter?: boolean
          updated_at?: string
          user_id: string
          viral_content_reduce?: boolean
          weight_discovery?: number
          weight_friends?: number
          weight_marketplace?: number
        }
        Update: {
          created_at?: string
          diversity_boost?: number
          feed_algorithm?: string
          muted_keywords?: string[]
          priority_topics?: string[]
          seen_posts_hide?: boolean
          sensitive_content_filter?: boolean
          updated_at?: string
          user_id?: string
          viral_content_reduce?: boolean
          weight_discovery?: number
          weight_friends?: number
          weight_marketplace?: number
        }
        Relationships: []
      }
      user_identity_change_events: {
        Row: {
          acknowledged: boolean
          acknowledged_at: string | null
          change_type: string
          id: number
          new_fingerprint: string
          observed_at: string
          observer_user_id: string
          peer_user_id: string
          previous_fingerprint: string | null
        }
        Insert: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          change_type?: string
          id?: number
          new_fingerprint: string
          observed_at?: string
          observer_user_id: string
          peer_user_id: string
          previous_fingerprint?: string | null
        }
        Update: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          change_type?: string
          id?: number
          new_fingerprint?: string
          observed_at?: string
          observer_user_id?: string
          peer_user_id?: string
          previous_fingerprint?: string | null
        }
        Relationships: []
      }
      user_interests: {
        Row: {
          created_at: string
          explicit: boolean
          id: string
          interest_type: string
          interest_value: string
          updated_at: string
          user_id: string
          weight: number
        }
        Insert: {
          created_at?: string
          explicit?: boolean
          id?: string
          interest_type: string
          interest_value: string
          updated_at?: string
          user_id: string
          weight?: number
        }
        Update: {
          created_at?: string
          explicit?: boolean
          id?: string
          interest_type?: string
          interest_value?: string
          updated_at?: string
          user_id?: string
          weight?: number
        }
        Relationships: []
      }
      user_known_fingerprints: {
        Row: {
          acknowledged: boolean
          fingerprint: string
          first_seen_at: string
          id: string
          last_seen_at: string
          peer_user_id: string
          user_id: string
          verified_manually: boolean
        }
        Insert: {
          acknowledged?: boolean
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          peer_user_id: string
          user_id: string
          verified_manually?: boolean
        }
        Update: {
          acknowledged?: boolean
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          peer_user_id?: string
          user_id?: string
          verified_manually?: boolean
        }
        Relationships: []
      }
      user_learned_profiles: {
        Row: {
          content_style: string | null
          created_at: string
          engagement_score: number | null
          id: string
          interests: Json | null
          last_analyzed_at: string | null
          posting_patterns: Json | null
          sentiment_average: number | null
          top_topics: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content_style?: string | null
          created_at?: string
          engagement_score?: number | null
          id?: string
          interests?: Json | null
          last_analyzed_at?: string | null
          posting_patterns?: Json | null
          sentiment_average?: number | null
          top_topics?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          content_style?: string | null
          created_at?: string
          engagement_score?: number | null
          id?: string
          interests?: Json | null
          last_analyzed_at?: string | null
          posting_patterns?: Json | null
          sentiment_average?: number | null
          top_topics?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_public_keys: {
        Row: {
          created_at: string
          fingerprint: string
          id: string
          identity_key: string
          is_active: boolean
          kem_type: string
          pq_public_key: string | null
          signing_key: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fingerprint: string
          id?: string
          identity_key: string
          is_active?: boolean
          kem_type?: string
          pq_public_key?: string | null
          signing_key: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          fingerprint?: string
          id?: string
          identity_key?: string
          is_active?: boolean
          kem_type?: string
          pq_public_key?: string | null
          signing_key?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_recovery_events: {
        Row: {
          fingerprint: string
          id: number
          occurred_at: string
          reason: string
          user_id: string
        }
        Insert: {
          fingerprint: string
          id?: number
          occurred_at?: string
          reason?: string
          user_id: string
        }
        Update: {
          fingerprint?: string
          id?: number
          occurred_at?: string
          reason?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_sender_certificates: {
        Row: {
          device_id: string
          expires_at: string
          fingerprint: string
          identity_epoch: number
          issued_at: string
          payload: string
          signature: string
          user_id: string
        }
        Insert: {
          device_id: string
          expires_at: string
          fingerprint: string
          identity_epoch: number
          issued_at?: string
          payload: string
          signature: string
          user_id: string
        }
        Update: {
          device_id?: string
          expires_at?: string
          fingerprint?: string
          identity_epoch?: number
          issued_at?: string
          payload?: string
          signature?: string
          user_id?: string
        }
        Relationships: []
      }
      user_signed_prekeys: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          is_active: boolean
          is_last_resort: boolean
          public_key: string
          signature: string
          signature_version: number
          spk_id: number
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          is_active?: boolean
          is_last_resort?: boolean
          public_key: string
          signature: string
          signature_version?: number
          spk_id: number
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          is_active?: boolean
          is_last_resort?: boolean
          public_key?: string
          signature?: string
          signature_version?: number
          spk_id?: number
          user_id?: string
        }
        Relationships: []
      }
      video_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          like_count: number
          parent_id: string | null
          user_id: string
          video_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          like_count?: number
          parent_id?: string | null
          user_id: string
          video_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          like_count?: number
          parent_id?: string | null
          user_id?: string
          video_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "video_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_comments_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "short_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      video_likes: {
        Row: {
          created_at: string
          id: string
          user_id: string
          video_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
          video_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
          video_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_likes_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "short_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      video_saves: {
        Row: {
          created_at: string
          id: string
          user_id: string
          video_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
          video_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
          video_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_saves_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "short_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      video_shares: {
        Row: {
          created_at: string
          id: string
          share_type: string | null
          user_id: string
          video_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          share_type?: string | null
          user_id: string
          video_id: string
        }
        Update: {
          created_at?: string
          id?: string
          share_type?: string | null
          user_id?: string
          video_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "video_shares_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "short_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      video_views: {
        Row: {
          completion_rate: number
          id: string
          replayed: boolean
          source: string | null
          user_id: string
          video_id: string
          viewed_at: string
          watch_time_seconds: number
        }
        Insert: {
          completion_rate?: number
          id?: string
          replayed?: boolean
          source?: string | null
          user_id: string
          video_id: string
          viewed_at?: string
          watch_time_seconds?: number
        }
        Update: {
          completion_rate?: number
          id?: string
          replayed?: boolean
          source?: string | null
          user_id?: string
          video_id?: string
          viewed_at?: string
          watch_time_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "video_views_video_id_fkey"
            columns: ["video_id"]
            isOneToOne: false
            referencedRelation: "short_videos"
            referencedColumns: ["id"]
          },
        ]
      }
      wellbeing_preferences: {
        Row: {
          bedtime_hour: number
          bedtime_reminder_enabled: boolean
          created_at: string
          daily_limit_minutes: number
          focus_mode_enabled: boolean
          grayscale_after_limit: boolean
          hide_like_counts: boolean
          scroll_pause_enabled: boolean
          scroll_pause_minutes: number
          updated_at: string
          user_id: string
        }
        Insert: {
          bedtime_hour?: number
          bedtime_reminder_enabled?: boolean
          created_at?: string
          daily_limit_minutes?: number
          focus_mode_enabled?: boolean
          grayscale_after_limit?: boolean
          hide_like_counts?: boolean
          scroll_pause_enabled?: boolean
          scroll_pause_minutes?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          bedtime_hour?: number
          bedtime_reminder_enabled?: boolean
          created_at?: string
          daily_limit_minutes?: number
          focus_mode_enabled?: boolean
          grayscale_after_limit?: boolean
          hide_like_counts?: boolean
          scroll_pause_enabled?: boolean
          scroll_pause_minutes?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      wellbeing_scores: {
        Row: {
          break_frequency_score: number
          computed_at: string
          content_diversity_score: number
          created_at: string
          factors: Json | null
          id: string
          positivity_score: number
          score: number
          screen_time_score: number
          social_balance_score: number
          updated_at: string
          user_id: string
        }
        Insert: {
          break_frequency_score?: number
          computed_at?: string
          content_diversity_score?: number
          created_at?: string
          factors?: Json | null
          id?: string
          positivity_score?: number
          score?: number
          screen_time_score?: number
          social_balance_score?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          break_frequency_score?: number
          computed_at?: string
          content_diversity_score?: number
          created_at?: string
          factors?: Json | null
          id?: string
          positivity_score?: number
          score?: number
          screen_time_score?: number
          social_balance_score?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      x3dh_replay_ledger: {
        Row: {
          consumed_at: string
          expires_at: string
          fingerprint: string
          id: string
          user_id: string
        }
        Insert: {
          consumed_at?: string
          expires_at?: string
          fingerprint: string
          id?: string
          user_id: string
        }
        Update: {
          consumed_at?: string
          expires_at?: string
          fingerprint?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      zeus_conversations: {
        Row: {
          created_at: string
          id: string
          messages: Json
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          messages?: Json
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          messages?: Json
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      zeus_memory: {
        Row: {
          category: string
          content: string
          created_at: string
          id: string
          importance: number
          source_message: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          category?: string
          content: string
          created_at?: string
          id?: string
          importance?: number
          source_message?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          id?: string
          importance?: number
          source_message?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      zeus_user_settings: {
        Row: {
          created_at: string | null
          custom_name: string | null
          id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          custom_name?: string | null
          id?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          custom_name?: string | null
          id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      anonymous_wall_messages_public: {
        Row: {
          author_id: string | null
          created_at: string | null
          id: string | null
          is_approved: boolean | null
          message: string | null
          target_user_id: string | null
        }
        Insert: {
          author_id?: never
          created_at?: string | null
          id?: string | null
          is_approved?: boolean | null
          message?: string | null
          target_user_id?: string | null
        }
        Update: {
          author_id?: never
          created_at?: string | null
          id?: string | null
          is_approved?: boolean | null
          message?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      anonymous_wall_messages_safe: {
        Row: {
          author_id: string | null
          created_at: string | null
          id: string | null
          is_approved: boolean | null
          message: string | null
          target_user_id: string | null
        }
        Insert: {
          author_id?: never
          created_at?: string | null
          id?: string | null
          is_approved?: boolean | null
          message?: string | null
          target_user_id?: string | null
        }
        Update: {
          author_id?: never
          created_at?: string | null
          id?: string | null
          is_approved?: boolean | null
          message?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      anonymous_wall_public: {
        Row: {
          created_at: string | null
          id: string | null
          is_approved: boolean | null
          message: string | null
          target_user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          is_approved?: boolean | null
          message?: string | null
          target_user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          is_approved?: boolean | null
          message?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      feed_posts_enriched: {
        Row: {
          author_avatar_url: string | null
          author_mood_emoji: string | null
          author_name: string | null
          author_profile_type: string | null
          body: string | null
          comments_count: number | null
          created_at: string | null
          expires_at: string | null
          id: string | null
          image_url: string | null
          likes_count: number | null
          user_id: string | null
        }
        Relationships: []
      }
      profiles_public: {
        Row: {
          age_verified: boolean | null
          avatar_url: string | null
          bio: string | null
          city: string | null
          created_at: string | null
          date_of_birth: string | null
          mood_emoji: string | null
          name: string | null
          onboarding_completed: boolean | null
          phone_number: string | null
          profile_music_url: string | null
          profile_type: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          age_verified?: boolean | null
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          created_at?: string | null
          date_of_birth?: never
          mood_emoji?: string | null
          name?: string | null
          onboarding_completed?: boolean | null
          phone_number?: never
          profile_music_url?: string | null
          profile_type?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          age_verified?: boolean | null
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          created_at?: string | null
          date_of_birth?: never
          mood_emoji?: string | null
          name?: string | null
          onboarding_completed?: boolean | null
          phone_number?: never
          profile_music_url?: string | null
          profile_type?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      profiles_safe: {
        Row: {
          avatar_url: string | null
          bio: string | null
          city: string | null
          created_at: string | null
          is_creator: boolean | null
          mood_emoji: string | null
          name: string | null
          profile_type: string | null
          user_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          created_at?: string | null
          is_creator?: boolean | null
          mood_emoji?: string | null
          name?: string | null
          profile_type?: string | null
          user_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          created_at?: string | null
          is_creator?: boolean | null
          mood_emoji?: string | null
          name?: string | null
          profile_type?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      public_profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          city: string | null
          created_at: string | null
          is_creator: boolean | null
          mood_emoji: string | null
          name: string | null
          profile_type: string | null
          user_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          created_at?: string | null
          is_creator?: boolean | null
          mood_emoji?: string | null
          name?: string | null
          profile_type?: string | null
          user_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          city?: string | null
          created_at?: string | null
          is_creator?: boolean | null
          mood_emoji?: string | null
          name?: string | null
          profile_type?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      add_group_members: {
        Args: { p_conv_id: string; p_member_ids: string[] }
        Returns: number
      }
      advance_onboarding_step: {
        Args: { _expected_step: number; _user_id: string }
        Returns: number
      }
      ai_engine_module_stats: {
        Args: { p_window_minutes?: number }
        Returns: {
          avg_latency_ms: number
          last_used: string
          module_id: string
          success_rate: number
          total_calls: number
        }[]
      }
      apply_security_auto_mitigations: { Args: never; Returns: Json }
      approve_device_link_request: {
        Args: {
          p_approver_device_id: string
          p_encrypted_payload: string
          p_token_hash: string
        }
        Returns: boolean
      }
      bump_device_keys_epoch: {
        Args: { p_device_id: string; p_user_id: string }
        Returns: number
      }
      call_signal: {
        Args: {
          p_action: string
          p_call_id?: string
          p_call_type?: string
          p_callee_id?: string
          p_caller_id?: string
          p_conversation_id?: string
          p_encrypted_call_key?: string
          p_status?: string
        }
        Returns: Json
      }
      can_view_order: {
        Args: { _buyer_id: string; _order_id: string }
        Returns: boolean
      }
      can_view_order_item: {
        Args: { _order_id: string; _seller_id: string }
        Returns: boolean
      }
      check_login_rate_limit: {
        Args: { p_email_hash: string; p_ip: string }
        Returns: Json
      }
      check_peer_knows_my_fingerprint: {
        Args: { p_peer_user_id: string }
        Returns: {
          acknowledged: boolean
          fingerprint: string
        }[]
      }
      check_rate_limit: {
        Args: {
          p_key: string
          p_max_requests: number
          p_window_seconds: number
        }
        Returns: boolean
      }
      claim_device_one_time_prekey: {
        Args: { p_device_id: string; p_user_id: string }
        Returns: {
          opk_id: number
          public_key: string
        }[]
      }
      claim_x3dh_initial: { Args: { p_fingerprint: string }; Returns: boolean }
      cleanup_ai_cache: { Args: never; Returns: undefined }
      cleanup_current_user_stale_devices: {
        Args: { p_current_device_id: string; p_stale_after?: string }
        Returns: Json
      }
      cleanup_edge_rate_limits: { Args: never; Returns: undefined }
      cleanup_expired_device_link_requests: { Args: never; Returns: undefined }
      cleanup_expired_device_links: { Args: never; Returns: undefined }
      cleanup_expired_device_prekeys: { Args: never; Returns: undefined }
      cleanup_old_behavior_signals: { Args: never; Returns: undefined }
      cleanup_old_fingerprints: { Args: never; Returns: undefined }
      cleanup_old_login_attempts: { Args: never; Returns: undefined }
      cleanup_stale_user_devices: {
        Args: never
        Returns: {
          action: string
          device_id: string
        }[]
      }
      complete_device_copy_retry: {
        Args: {
          p_encrypted_body: string
          p_request_id: string
          p_sender_device_id: string
        }
        Returns: Json
      }
      complete_device_link_request: {
        Args: { p_requester_device_id: string; p_token_hash: string }
        Returns: boolean
      }
      complete_onboarding: { Args: { _user_id: string }; Returns: boolean }
      consume_device_link_token: {
        Args: { p_token_hash: string }
        Returns: {
          encrypted_payload: string
          user_id: string
        }[]
      }
      consume_device_prekey_repair_requests: {
        Args: { p_limit?: number }
        Returns: {
          created_at: string
          id: string
          owner_device_id: string
          reason: string
          reporter_user_id: string
        }[]
      }
      count_device_one_time_prekeys: {
        Args: { p_device_id: string; p_user_id: string }
        Returns: number
      }
      create_device_link_request: {
        Args: {
          p_requester_device_id: string
          p_requester_label?: string
          p_requester_public_key: Json
          p_token_hash: string
        }
        Returns: string
      }
      create_group_conversation: {
        Args: { p_member_ids: string[]; p_name: string }
        Returns: string
      }
      create_or_get_dm_conversation: {
        Args: { p_other_user: string }
        Returns: string
      }
      ddos_check_ip: {
        Args: {
          p_endpoint?: string
          p_ip: string
          p_max_requests?: number
          p_window_seconds?: number
        }
        Returns: Json
      }
      ddos_cleanup: { Args: never; Returns: undefined }
      decrement_product_stock: {
        Args: { p_product_id: string; p_quantity: number }
        Returns: boolean
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      ensure_primary_device_exists: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      ensure_user_crypto_state: {
        Args: never
        Returns: {
          client_key_published_at: string | null
          created_at: string
          fingerprint: string | null
          identity_epoch: number
          key_slot_id: string
          status: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "user_crypto_state"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      feed_score_batch: {
        Args: { p_algo?: string; p_post_ids: string[]; p_user_id: string }
        Returns: {
          classic_score: number
          final_score: number
          ml_score: number
          post_id: string
          reason: string
        }[]
      }
      generate_order_number: { Args: never; Returns: string }
      get_active_device_public_key: {
        Args: { p_device_id: string; p_user_id: string }
        Returns: {
          device_id: string
          device_public_key: string
          user_id: string
        }[]
      }
      get_ai_data_sharing_enabled: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      get_approved_device_link_payload: {
        Args: { p_requester_device_id: string; p_token_hash: string }
        Returns: {
          approver_device_id: string
          encrypted_payload: string
        }[]
      }
      get_conversation_deliverable_devices: {
        Args: { p_conversation_id: string; p_exclude_device_id?: string }
        Returns: {
          device_id: string
          device_public_key: string
          is_self: boolean
          user_id: string
        }[]
      }
      get_conversations_with_details: {
        Args: { p_user_id: string }
        Returns: {
          conv_created_at: string
          conv_id: string
          conv_name: string
          conv_updated_at: string
          created_by: string
          is_group: boolean
          last_message_at: string
          last_message_body: string
          last_message_sender: string
          other_avatar: string
          other_name: string
          other_user_id: string
          unread_count: number
        }[]
      }
      get_device_copies_for_user: {
        Args: { p_message_id: string }
        Returns: {
          created_at: string
          encrypted_body: string
          recipient_device_id: string
          sender_device_id: string
          sender_user_id: string
        }[]
      }
      get_device_copy_for_message: {
        Args: { p_device_id: string; p_message_id: string }
        Returns: {
          created_at: string
          encrypted_body: string
          sender_device_id: string
          sender_user_id: string
        }[]
      }
      get_device_link_request_for_approval: {
        Args: { p_token_hash: string }
        Returns: {
          expires_at: string
          id: string
          requester_device_id: string
          requester_label: string
          requester_public_key: Json
          status: string
        }[]
      }
      get_device_prekey_bundle: {
        Args: { p_device_id: string; p_user_id: string }
        Returns: {
          public_key: string
          signature: string
          spk_id: number
        }[]
      }
      get_feed_posts: {
        Args: { p_limit?: number; p_offset?: number; p_user_id: string }
        Returns: {
          author_avatar: string
          author_mood: string
          author_name: string
          body: string
          comments_count: number
          created_at: string
          expires_at: string
          id: string
          image_url: string
          is_friend: boolean
          likes_count: number
          user_id: string
          user_reaction: string
        }[]
      }
      get_friend_suggestions: {
        Args: { limit_count?: number; target_user_id: string }
        Returns: {
          avatar_url: string
          bio: string
          city: string
          mutual_friends_count: number
          name: string
          profile_type: string
          user_id: string
        }[]
      }
      get_my_live_stream_key: { Args: { _stream_id: string }; Returns: string }
      get_my_seller_revenue: { Args: never; Returns: number }
      get_my_stream_key: { Args: { p_stream_id: string }; Returns: string }
      get_onboarding_state: { Args: { _user_id: string }; Returns: Json }
      get_parental_controls: {
        Args: { p_user_id: string }
        Returns: {
          allowed_categories: string[]
          created_at: string
          id: string
          is_active: boolean
          is_minor: boolean
          updated_at: string
          user_id: string
        }[]
      }
      get_pending_device_copy_retry_requests: {
        Args: { p_limit?: number }
        Returns: {
          conversation_id: string
          created_at: string
          id: string
          message_id: string
          requester_device_id: string
          requester_user_id: string
        }[]
      }
      get_public_profile: {
        Args: { profile_user_id: string }
        Returns: {
          avatar_url: string
          bio: string
          city: string
          country: string
          cover_url: string
          creator_tier: string
          id: string
          is_creator: boolean
          mood_emoji: string
          name: string
          user_id: string
        }[]
      }
      get_public_trust_score: { Args: { p_user_id: string }; Returns: number }
      get_public_wellbeing_score: {
        Args: { p_user_id: string }
        Returns: number
      }
      get_safe_live_stream: {
        Args: { p_live_id: string }
        Returns: {
          category: string
          created_at: string
          description: string
          ended_at: string
          hashtags: string[]
          id: string
          is_active: boolean
          peak_viewer_count: number
          recording_url: string
          started_at: string
          stream_key: string
          thumbnail_url: string
          title: string
          total_views: number
          user_id: string
          viewer_count: number
        }[]
      }
      get_signed_device_list: {
        Args: { p_user_id: string }
        Returns: {
          device_id: string
          device_public_key: string
          is_primary: boolean
          primary_device_id: string
          primary_pub_b64: string
          signature_b64: string
          signed_at: string
        }[]
      }
      get_signed_prekey: {
        Args: { p_user_id: string }
        Returns: {
          public_key: string
          signature: string
          spk_id: number
        }[]
      }
      get_signed_prekey_with_fallback: {
        Args: { p_user_id: string }
        Returns: {
          is_last_resort: boolean
          public_key: string
          signature: string
          spk_id: number
        }[]
      }
      get_user_archive_keys: {
        Args: never
        Returns: {
          conversation_id: string
          created_at: string
          kdf_version: number
          wrapped_key: string
        }[]
      }
      has_backup_pin: { Args: { _user_id?: string }; Returns: boolean }
      has_chat_pin: { Args: { p_user_id: string }; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_conversation_participant: {
        Args: { conv_id: string; uid: string }
        Returns: boolean
      }
      is_restricted_by: {
        Args: { p_owner_id: string; p_viewer_id: string }
        Returns: boolean
      }
      is_user_device_revoked: {
        Args: { p_device_id: string; p_user_id: string }
        Returns: boolean
      }
      is_user_minor: { Args: { p_user_id: string }; Returns: boolean }
      list_active_devices_for_user: {
        Args: { p_user_id: string }
        Returns: {
          device_id: string
          device_public_key: string
          last_seen_at: string
          platform: string
        }[]
      }
      list_pending_device_copy_retries: {
        Args: { p_limit?: number }
        Returns: {
          attempt_count: number
          conversation_id: string
          created_at: string
          message_body: string
          message_id: string
          request_id: string
          requester_device_id: string
          requester_device_public_key: string
          requester_user_id: string
        }[]
      }
      list_predecessor_device_ids: {
        Args: { p_fingerprints: string[] }
        Returns: {
          device_id: string
        }[]
      }
      live_feed_bundle: {
        Args: {
          p_active_limit?: number
          p_replay_limit?: number
          p_user_id: string
        }
        Returns: Json
      }
      live_score_batch: {
        Args: { p_limit: number; p_user_id: string }
        Returns: {
          engagement_score: number
          freshness_score: number
          live_id: string
          score: number
          wellbeing_score: number
        }[]
      }
      mark_device_copy_retry_failed: {
        Args: { p_error?: string; p_request_id: string }
        Returns: Json
      }
      mark_device_copy_retry_request: {
        Args: { p_error?: string; p_request_id: string; p_status: string }
        Returns: Json
      }
      mark_user_crypto_ready: {
        Args: { p_fingerprint: string }
        Returns: {
          client_key_published_at: string | null
          created_at: string
          fingerprint: string | null
          identity_epoch: number
          key_slot_id: string
          status: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "user_crypto_state"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      match_contacts_by_phone:
        | {
            Args: { p_phone_numbers: string[] }
            Returns: {
              avatar_url: string
              is_friend: boolean
              name: string
              user_id: string
            }[]
          }
        | {
            Args: { p_phone_numbers: string[]; p_user_id: string }
            Returns: {
              avatar_url: string
              is_friend: boolean
              name: string
              phone_number: string
              user_id: string
            }[]
          }
      ml_cold_start_feed: {
        Args: { p_limit?: number; p_user_id: string }
        Returns: {
          post_id: string
          score: number
        }[]
      }
      ml_compute_post_scores: {
        Args: { p_post_id: string }
        Returns: undefined
      }
      ml_find_similar_posts: {
        Args: { p_limit?: number; p_user_id: string }
        Returns: {
          post_id: string
          similarity: number
        }[]
      }
      ml_is_cold_start: { Args: { p_user_id: string }; Returns: boolean }
      ml_pareto_score: {
        Args: {
          p_post_id: string
          p_user_id: string
          p_w_engagement?: number
          p_w_revenue?: number
          p_w_wellbeing?: number
        }
        Returns: number
      }
      ml_pareto_score_batch: {
        Args: { p_post_ids: string[]; p_user_id: string }
        Returns: {
          post_id: string
          score: number
        }[]
      }
      ml_record_watch_time: {
        Args: { p_post_id: string; p_sample_count: number; p_total_ms: number }
        Returns: undefined
      }
      ml_score_post: {
        Args: { p_post_id: string; p_user_id: string }
        Returns: number
      }
      ml_score_post_v2: {
        Args: { p_post_id: string; p_user_id: string }
        Returns: number
      }
      ml_score_post_v3: {
        Args: { p_post_id: string; p_user_id: string }
        Returns: number
      }
      ml_score_post_v4: {
        Args: { p_post_id: string; p_user_id: string }
        Returns: number
      }
      ml_score_post_v5: {
        Args: { p_post_id: string; p_user_id: string }
        Returns: number
      }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      purge_old_ai_engine_events: { Args: never; Returns: undefined }
      purge_old_audit_logs: { Args: never; Returns: undefined }
      purge_old_crypto_error_logs: { Args: never; Returns: number }
      purge_old_feed_score_tamper_events: { Args: never; Returns: undefined }
      purge_old_threat_decisions: { Args: never; Returns: undefined }
      push_my_fingerprint_to_peers: { Args: never; Returns: number }
      quality_metrics_summary: {
        Args: { p_author_id?: string; p_since?: string; p_surface?: string }
        Returns: Json
      }
      quality_metrics_timeline: {
        Args: {
          p_author_id?: string
          p_bucket?: string
          p_since?: string
          p_surface?: string
        }
        Returns: {
          avg_completion: number
          avg_watch_ms: number
          bucket: string
          ios_perf_ms: number
          skip_fast: number
          views: number
        }[]
      }
      quarantine_ghost_e2ee_devices: { Args: never; Returns: number }
      quarantine_own_invalid_device: {
        Args: { p_device_id: string; p_reason?: string }
        Returns: Json
      }
      quarantine_own_invalid_device_spk: {
        Args: { p_device_id: string; p_reason?: string; p_spk_id: number }
        Returns: Json
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      record_login_attempt: {
        Args: {
          p_email_hash: string
          p_ip: string
          p_success: boolean
          p_user_agent?: string
        }
        Returns: undefined
      }
      register_user_device_safe: {
        Args: {
          p_device_fingerprint?: string
          p_device_id: string
          p_device_name?: string
          p_device_public_key?: string
          p_platform?: string
          p_user_agent?: string
          p_user_id: string
        }
        Returns: Json
      }
      release_backup_master_key: {
        Args: { _backup_type: string; _user_id: string }
        Returns: {
          allowed: boolean
          attempts_remaining: number
          locked_until: string
          master_key_iv: string
          wrapped_master_key: string
        }[]
      }
      release_backup_pin_blob: {
        Args: { _user_id: string }
        Returns: {
          allowed: boolean
          attempts_remaining: number
          kdf_version: number
          locked_until: string
          pin_wrap_master: string
          salt: string
        }[]
      }
      request_device_copy_retry: {
        Args: {
          p_message_id: string
          p_requester_device_id: string
          p_sender_user_id: string
        }
        Returns: Json
      }
      request_device_prekey_repair: {
        Args: {
          p_owner_device_id: string
          p_owner_user_id: string
          p_reason?: string
        }
        Returns: Json
      }
      request_message_refanout: {
        Args: {
          p_message_id: string
          p_requester_device_id: string
          p_sender_user_id: string
        }
        Returns: Json
      }
      reset_backup_pin_attempts: {
        Args: { _user_id: string }
        Returns: undefined
      }
      resolve_device_id_by_fingerprint: {
        Args: { p_fingerprint: string }
        Returns: string
      }
      resolve_device_id_by_fingerprints: {
        Args: { p_fingerprints: string[]; p_platform?: string }
        Returns: string
      }
      resolve_device_primary_repair_request: {
        Args: { p_id: string }
        Returns: boolean
      }
      security_monitor_cron_tick: { Args: never; Returns: undefined }
      send_message_with_device_copies: {
        Args: {
          p_body: string
          p_conversation_id: string
          p_copies?: Json
          p_extra?: Json
          p_image_url?: string
          p_message_id: string
        }
        Returns: string
      }
      set_message_archive_body: {
        Args: { p_archive_body: string; p_message_id: string }
        Returns: boolean
      }
      stripe_mark_event_processed: {
        Args: { p_event_id: string; p_event_type: string }
        Returns: boolean
      }
      threat_shield_active_model: {
        Args: never
        Returns: {
          accuracy: number
          bias: number
          samples_used: number
          trained_at: string
          version: number
          weights: Json
        }[]
      }
      threat_shield_feedback: {
        Args: { p_decision_id: string; p_is_attack: boolean }
        Returns: undefined
      }
      threat_shield_ml_stats: {
        Args: never
        Returns: {
          active_accuracy: number
          active_precision: number
          active_recall: number
          active_version: number
          decided_by_gemini: number
          decided_by_ml: number
          decided_by_regex: number
          positive_samples: number
          total_samples: number
        }[]
      }
      threat_shield_stats: {
        Args: { window_minutes?: number }
        Returns: {
          banned: number
          last_block: string
          logged: number
          penalized: number
          top_category: string
          total: number
        }[]
      }
      try_consume_backup_pin_attempt: {
        Args: {
          _lockout_seconds?: number
          _max_attempts?: number
          _user_id: string
          _window_seconds?: number
        }
        Returns: {
          allowed: boolean
          attempts_remaining: number
          locked_until: string
        }[]
      }
      upsert_signed_device_list: {
        Args: {
          p_device_ids: string[]
          p_signature?: string
          p_signer_device_id?: string
        }
        Returns: Json
      }
      video_score_batch: {
        Args: { p_user_id: string; p_video_ids: string[] }
        Returns: {
          engagement_score: number
          score: number
          velocity_score: number
          video_id: string
          wellbeing_score: number
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      friendship_status: "pending" | "accepted" | "rejected"
      notification_type:
        | "like"
        | "comment"
        | "reaction"
        | "friend_request"
        | "friend_accepted"
        | "message"
        | "story_view"
        | "sale"
        | "new_device"
      order_status:
        | "pending"
        | "paid"
        | "processing"
        | "shipped"
        | "delivered"
        | "cancelled"
        | "refunded"
      product_type: "physical" | "digital" | "service"
      reaction_type: "like" | "love" | "haha" | "wow" | "sad" | "angry"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
      friendship_status: ["pending", "accepted", "rejected"],
      notification_type: [
        "like",
        "comment",
        "reaction",
        "friend_request",
        "friend_accepted",
        "message",
        "story_view",
        "sale",
        "new_device",
      ],
      order_status: [
        "pending",
        "paid",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
        "refunded",
      ],
      product_type: ["physical", "digital", "service"],
      reaction_type: ["like", "love", "haha", "wow", "sad", "angry"],
    },
  },
} as const
