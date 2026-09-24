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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account: {
        Row: {
          archived: boolean
          color: string | null
          created_at: string
          credit_limit: number | null
          currency: string
          household_id: string
          id: string
          institution: string | null
          is_suspense: boolean
          kind: string
          last4: string | null
          name: string
          opening_balance: number
          opening_on: string | null
          sort: number
          updated_at: string
        }
        Insert: {
          archived?: boolean
          color?: string | null
          created_at?: string
          credit_limit?: number | null
          currency?: string
          household_id: string
          id?: string
          institution?: string | null
          is_suspense?: boolean
          kind: string
          last4?: string | null
          name: string
          opening_balance?: number
          opening_on?: string | null
          sort?: number
          updated_at?: string
        }
        Update: {
          archived?: boolean
          color?: string | null
          created_at?: string
          credit_limit?: number | null
          currency?: string
          household_id?: string
          id?: string
          institution?: string | null
          is_suspense?: boolean
          kind?: string
          last4?: string | null
          name?: string
          opening_balance?: number
          opening_on?: string | null
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      app_meta: {
        Row: {
          key: string
          value: string
        }
        Insert: {
          key: string
          value: string
        }
        Update: {
          key?: string
          value?: string
        }
        Relationships: []
      }
      attachment: {
        Row: {
          bytes: number | null
          created_at: string
          created_by: string | null
          drive_file_id: string | null
          entity_id: string
          entity_type: string
          height: number | null
          household_id: string
          id: string
          is_primary: boolean
          kind: string
          mime: string | null
          ocr_json: Json | null
          provider: string
          storage_path: string
          thumb_path: string | null
          width: number | null
        }
        Insert: {
          bytes?: number | null
          created_at?: string
          created_by?: string | null
          drive_file_id?: string | null
          entity_id: string
          entity_type: string
          height?: number | null
          household_id: string
          id?: string
          is_primary?: boolean
          kind?: string
          mime?: string | null
          ocr_json?: Json | null
          provider?: string
          storage_path: string
          thumb_path?: string | null
          width?: number | null
        }
        Update: {
          bytes?: number | null
          created_at?: string
          created_by?: string | null
          drive_file_id?: string | null
          entity_id?: string
          entity_type?: string
          height?: number | null
          household_id?: string
          id?: string
          is_primary?: boolean
          kind?: string
          mime?: string | null
          ocr_json?: Json | null
          provider?: string
          storage_path?: string
          thumb_path?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "attachment_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      category: {
        Row: {
          archived: boolean
          color: string | null
          created_at: string
          default_destiny: string
          household_id: string
          icon: string | null
          id: string
          key: string | null
          kind: string
          name: string
          parent_id: string | null
          sort: number
          updated_at: string
        }
        Insert: {
          archived?: boolean
          color?: string | null
          created_at?: string
          default_destiny?: string
          household_id: string
          icon?: string | null
          id?: string
          key?: string | null
          kind?: string
          name: string
          parent_id?: string | null
          sort?: number
          updated_at?: string
        }
        Update: {
          archived?: boolean
          color?: string | null
          created_at?: string
          default_destiny?: string
          household_id?: string
          icon?: string | null
          id?: string
          key?: string | null
          kind?: string
          name?: string
          parent_id?: string | null
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "category_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
        ]
      }
      household: {
        Row: {
          created_at: string
          currency: string
          id: string
          locale: string
          name: string
          settings: Json
          timezone: string
        }
        Insert: {
          created_at?: string
          currency?: string
          id?: string
          locale?: string
          name: string
          settings?: Json
          timezone?: string
        }
        Update: {
          created_at?: string
          currency?: string
          id?: string
          locale?: string
          name?: string
          settings?: Json
          timezone?: string
        }
        Relationships: []
      }
      household_invite: {
        Row: {
          accepted_at: string | null
          created_at: string
          display_name: string | null
          email: string
          household_id: string
          role: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          household_id: string
          role: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          household_id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "household_invite_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      household_member: {
        Row: {
          created_at: string
          display_name: string | null
          household_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          household_id: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          household_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "household_member_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      label_profile: {
        Row: {
          cols: number
          created_at: string
          gutter_x: number
          gutter_y: number
          household_id: string
          id: string
          margin_bottom: number
          margin_left: number
          margin_right: number
          margin_top: number
          name: string
          offset_x: number
          offset_y: number
          orientation: string
          qr_mm: number
          rows: number
          template: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          cols?: number
          created_at?: string
          gutter_x?: number
          gutter_y?: number
          household_id: string
          id?: string
          margin_bottom?: number
          margin_left?: number
          margin_right?: number
          margin_top?: number
          name: string
          offset_x?: number
          offset_y?: number
          orientation?: string
          qr_mm?: number
          rows?: number
          template?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          cols?: number
          created_at?: string
          gutter_x?: number
          gutter_y?: number
          household_id?: string
          id?: string
          margin_bottom?: number
          margin_left?: number
          margin_right?: number
          margin_top?: number
          name?: string
          offset_x?: number
          offset_y?: number
          orientation?: string
          qr_mm?: number
          rows?: number
          template?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "label_profile_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      location: {
        Row: {
          climate: string | null
          code: string
          created_at: string
          created_by: string | null
          household_id: string
          id: string
          kind: string | null
          map_x: number | null
          map_y: number | null
          name: string
          notes: string | null
          parent_id: string | null
          path: string
          sort: number
          updated_at: string
        }
        Insert: {
          climate?: string | null
          code: string
          created_at?: string
          created_by?: string | null
          household_id: string
          id?: string
          kind?: string | null
          map_x?: number | null
          map_y?: number | null
          name: string
          notes?: string | null
          parent_id?: string | null
          path: string
          sort?: number
          updated_at?: string
        }
        Update: {
          climate?: string | null
          code?: string
          created_at?: string
          created_by?: string | null
          household_id?: string
          id?: string
          kind?: string | null
          map_x?: number | null
          map_y?: number | null
          name?: string
          notes?: string | null
          parent_id?: string | null
          path?: string
          sort?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
        ]
      }
      merchant: {
        Row: {
          aliases: string[]
          created_at: string
          household_id: string
          id: string
          kind: string | null
          location_text: string | null
          name: string
          name_norm: string | null
          updated_at: string
        }
        Insert: {
          aliases?: string[]
          created_at?: string
          household_id: string
          id?: string
          kind?: string | null
          location_text?: string | null
          name: string
          name_norm?: string | null
          updated_at?: string
        }
        Update: {
          aliases?: string[]
          created_at?: string
          household_id?: string
          id?: string
          kind?: string | null
          location_text?: string | null
          name?: string
          name_norm?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      money_transaction: {
        Row: {
          account_id: string
          created_at: string
          created_by: string | null
          discount: number
          fingerprint: string
          household_id: string
          id: string
          invoice_no: string | null
          merchant_id: string | null
          notes: string | null
          occurred_at: string | null
          occurred_on: string
          payee_text: string | null
          related_id: string | null
          source: string
          subtotal: number | null
          to_account_id: string | null
          total: number
          type: string
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          created_by?: string | null
          discount?: number
          fingerprint: string
          household_id: string
          id?: string
          invoice_no?: string | null
          merchant_id?: string | null
          notes?: string | null
          occurred_at?: string | null
          occurred_on: string
          payee_text?: string | null
          related_id?: string | null
          source?: string
          subtotal?: number | null
          to_account_id?: string | null
          total: number
          type: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          created_by?: string | null
          discount?: number
          fingerprint?: string
          household_id?: string
          id?: string
          invoice_no?: string | null
          merchant_id?: string | null
          notes?: string | null
          occurred_at?: string | null
          occurred_on?: string
          payee_text?: string | null
          related_id?: string | null
          source?: string
          subtotal?: number | null
          to_account_id?: string | null
          total?: number
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "money_transaction_household_id_account_id_fkey"
            columns: ["household_id", "account_id"]
            isOneToOne: false
            referencedRelation: "account"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_account_id_fkey"
            columns: ["household_id", "account_id"]
            isOneToOne: false
            referencedRelation: "v_account_balance"
            referencedColumns: ["household_id", "account_id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_account_id_fkey"
            columns: ["household_id", "account_id"]
            isOneToOne: false
            referencedRelation: "v_sms_balance_check"
            referencedColumns: ["household_id", "account_id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_merchant_id_fkey"
            columns: ["household_id", "merchant_id"]
            isOneToOne: false
            referencedRelation: "merchant"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_related_id_fkey"
            columns: ["household_id", "related_id"]
            isOneToOne: false
            referencedRelation: "money_transaction"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_to_account_id_fkey"
            columns: ["household_id", "to_account_id"]
            isOneToOne: false
            referencedRelation: "account"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_to_account_id_fkey"
            columns: ["household_id", "to_account_id"]
            isOneToOne: false
            referencedRelation: "v_account_balance"
            referencedColumns: ["household_id", "account_id"]
          },
          {
            foreignKeyName: "money_transaction_household_id_to_account_id_fkey"
            columns: ["household_id", "to_account_id"]
            isOneToOne: false
            referencedRelation: "v_sms_balance_check"
            referencedColumns: ["household_id", "account_id"]
          },
        ]
      }
      sms_device: {
        Row: {
          created_at: string
          created_by: string | null
          dropped_count: number
          household_id: string
          id: string
          last_rejected_at: string | null
          last_rejected_sender: string | null
          last_seen_at: string | null
          message_count: number
          name: string
          revoked_at: string | null
          token_hash: string
          token_hint: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dropped_count?: number
          household_id: string
          id?: string
          last_rejected_at?: string | null
          last_rejected_sender?: string | null
          last_seen_at?: string | null
          message_count?: number
          name: string
          revoked_at?: string | null
          token_hash: string
          token_hint: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dropped_count?: number
          household_id?: string
          id?: string
          last_rejected_at?: string | null
          last_rejected_sender?: string | null
          last_seen_at?: string | null
          message_count?: number
          name?: string
          revoked_at?: string | null
          token_hash?: string
          token_hint?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_device_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_message: {
        Row: {
          account_id: string | null
          amount: number | null
          balance_after: number | null
          bank_txn_id: string | null
          body: string
          channel: string
          created_at: string
          currency: string
          device_id: string | null
          fingerprint: string
          household_id: string
          id: string
          ignored: boolean
          institution: string | null
          kind: string
          last_digits: string | null
          merchant_text: string | null
          occurred_at: string | null
          occurred_on: string
          parser: string | null
          parser_version: number | null
          received_at: string
          reviewed_at: string | null
          reviewed_by: string | null
          sender: string
          transaction_id: string | null
        }
        Insert: {
          account_id?: string | null
          amount?: number | null
          balance_after?: number | null
          bank_txn_id?: string | null
          body: string
          channel: string
          created_at?: string
          currency?: string
          device_id?: string | null
          fingerprint: string
          household_id: string
          id?: string
          ignored?: boolean
          institution?: string | null
          kind: string
          last_digits?: string | null
          merchant_text?: string | null
          occurred_at?: string | null
          occurred_on: string
          parser?: string | null
          parser_version?: number | null
          received_at: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sender: string
          transaction_id?: string | null
        }
        Update: {
          account_id?: string | null
          amount?: number | null
          balance_after?: number | null
          bank_txn_id?: string | null
          body?: string
          channel?: string
          created_at?: string
          currency?: string
          device_id?: string | null
          fingerprint?: string
          household_id?: string
          id?: string
          ignored?: boolean
          institution?: string | null
          kind?: string
          last_digits?: string | null
          merchant_text?: string | null
          occurred_at?: string | null
          occurred_on?: string
          parser?: string | null
          parser_version?: number | null
          received_at?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sender?: string
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_message_household_id_account_id_fkey"
            columns: ["household_id", "account_id"]
            isOneToOne: false
            referencedRelation: "account"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "sms_message_household_id_account_id_fkey"
            columns: ["household_id", "account_id"]
            isOneToOne: false
            referencedRelation: "v_account_balance"
            referencedColumns: ["household_id", "account_id"]
          },
          {
            foreignKeyName: "sms_message_household_id_account_id_fkey"
            columns: ["household_id", "account_id"]
            isOneToOne: false
            referencedRelation: "v_sms_balance_check"
            referencedColumns: ["household_id", "account_id"]
          },
          {
            foreignKeyName: "sms_message_household_id_device_id_fkey"
            columns: ["household_id", "device_id"]
            isOneToOne: false
            referencedRelation: "sms_device"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "sms_message_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_message_household_id_transaction_id_fkey"
            columns: ["household_id", "transaction_id"]
            isOneToOne: false
            referencedRelation: "money_transaction"
            referencedColumns: ["household_id", "id"]
          },
        ]
      }
      transaction_line: {
        Row: {
          amount: number
          base_qty: number | null
          category_id: string | null
          destiny: string | null
          fingerprint: string
          household_id: string
          id: string
          line_no: number
          price_per_base: number | null
          qty: number | null
          raw_name: string
          transaction_id: string
          unit_id: string | null
          unit_price: number | null
          unit_text: string | null
        }
        Insert: {
          amount: number
          base_qty?: number | null
          category_id?: string | null
          destiny?: string | null
          fingerprint: string
          household_id: string
          id?: string
          line_no: number
          price_per_base?: number | null
          qty?: number | null
          raw_name: string
          transaction_id: string
          unit_id?: string | null
          unit_price?: number | null
          unit_text?: string | null
        }
        Update: {
          amount?: number
          base_qty?: number | null
          category_id?: string | null
          destiny?: string | null
          fingerprint?: string
          household_id?: string
          id?: string
          line_no?: number
          price_per_base?: number | null
          qty?: number | null
          raw_name?: string
          transaction_id?: string
          unit_id?: string | null
          unit_price?: number | null
          unit_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "transaction_line_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "transaction_line_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_line_household_id_transaction_id_fkey"
            columns: ["household_id", "transaction_id"]
            isOneToOne: false
            referencedRelation: "money_transaction"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "transaction_line_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
          },
        ]
      }
      unit: {
        Row: {
          aliases: string[]
          code: string
          created_at: string
          dimension: string
          household_id: string | null
          id: string
          name: string
          to_base: number
        }
        Insert: {
          aliases?: string[]
          code: string
          created_at?: string
          dimension: string
          household_id?: string | null
          id?: string
          name: string
          to_base: number
        }
        Update: {
          aliases?: string[]
          code?: string
          created_at?: string
          dimension?: string
          household_id?: string | null
          id?: string
          name?: string
          to_base?: number
        }
        Relationships: [
          {
            foreignKeyName: "unit_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_account_balance: {
        Row: {
          account_id: string | null
          available: number | null
          balance: number | null
          household_id: string | null
          is_set_up: boolean | null
          last_on: string | null
          transaction_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "account_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      v_account_effect: {
        Row: {
          account_id: string | null
          effect: number | null
          household_id: string | null
          occurred_on: string | null
          transaction_id: string | null
        }
        Relationships: []
      }
      v_monthly_cashflow: {
        Row: {
          bills: number | null
          household_id: string | null
          income: number | null
          month: string | null
          net: number | null
          spent: number | null
        }
        Relationships: [
          {
            foreignKeyName: "money_transaction_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      v_sms_balance_check: {
        Row: {
          account_id: string | null
          bank_reported: number | null
          gedara_value: number | null
          household_id: string | null
          is_set_up: boolean | null
          reported_at: string | null
          sms_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      v_spend_by_category_month: {
        Row: {
          category_id: string | null
          household_id: string | null
          lines: number | null
          month: string | null
          spent: number | null
          top_category_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "transaction_line_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "transaction_line_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_invites_for: {
        Args: { p_email: string; p_user_id: string }
        Returns: number
      }
      accept_pending_invites: { Args: never; Returns: number }
      rpc_delete_transaction: { Args: { p_id: string }; Returns: undefined }
      rpc_import_bills: {
        Args: { p_bills: Json; p_household: string }
        Returns: Json
      }
      rpc_move_transactions: {
        Args: { p_account: string; p_ids: string[] }
        Returns: number
      }
      rpc_save_transaction: { Args: { p: Json }; Returns: Json }
      rpc_sms_device_create: {
        Args: { p_household: string; p_name: string }
        Returns: Json
      }
      rpc_sms_device_revoke: { Args: { p_id: string }; Returns: undefined }
      rpc_sms_ignore: {
        Args: { p_ids: string[]; p_ignored: boolean }
        Returns: number
      }
      rpc_sms_import: {
        Args: { p_household: string; p_messages: Json }
        Returns: Json
      }
      rpc_sms_ingest_device: {
        Args: {
          p_dropped?: number
          p_messages: Json
          p_rejected_sender?: string
          p_token_hash: string
        }
        Returns: Json
      }
      rpc_sms_link: {
        Args: { p_sms_ids: string[]; p_transaction: string }
        Returns: Json
      }
      rpc_sms_post: { Args: { p: Json; p_sms_ids: string[] }; Returns: Json }
      rpc_sms_unlink: { Args: { p_ids: string[] }; Returns: number }
      safe_uuid: { Args: { p: string }; Returns: string }
      schema_version: { Args: never; Returns: number }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
