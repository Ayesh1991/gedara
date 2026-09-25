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
      activity: {
        Row: {
          actor: string | null
          at: string
          entity_id: string
          entity_type: string
          household_id: string
          id: number
          payload: Json
          summary: string | null
          verb: string
        }
        Insert: {
          actor?: string | null
          at?: string
          entity_id: string
          entity_type: string
          household_id: string
          id?: never
          payload?: Json
          summary?: string | null
          verb: string
        }
        Update: {
          actor?: string | null
          at?: string
          entity_id?: string
          entity_type?: string
          household_id?: string
          id?: never
          payload?: Json
          summary?: string | null
          verb?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_household_id_fkey"
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
      asset: {
        Row: {
          archived: boolean
          asset_no: number
          category_id: string | null
          code: string
          condition: string | null
          created_at: string
          created_by: string | null
          custom: Json
          description: string | null
          household_id: string
          id: string
          insurance_notes: string | null
          insured: boolean
          lent_on: string | null
          lent_to: string | null
          lifetime_warranty: boolean
          location_id: string | null
          manufacturer: string | null
          model_no: string | null
          name: string
          parent_id: string | null
          purchase_price: number | null
          purchased_on: string | null
          quantity: number
          sale_transaction_id: string | null
          salvage_value: number | null
          serial_no: string | null
          sold_on: string | null
          sold_price: number | null
          sold_to: string | null
          status: string
          transaction_line_id: string | null
          updated_at: string
          useful_life_months: number | null
          vendor: string | null
          warranty_notes: string | null
          warranty_until: string | null
        }
        Insert: {
          archived?: boolean
          asset_no: number
          category_id?: string | null
          code: string
          condition?: string | null
          created_at?: string
          created_by?: string | null
          custom?: Json
          description?: string | null
          household_id: string
          id?: string
          insurance_notes?: string | null
          insured?: boolean
          lent_on?: string | null
          lent_to?: string | null
          lifetime_warranty?: boolean
          location_id?: string | null
          manufacturer?: string | null
          model_no?: string | null
          name: string
          parent_id?: string | null
          purchase_price?: number | null
          purchased_on?: string | null
          quantity?: number
          sale_transaction_id?: string | null
          salvage_value?: number | null
          serial_no?: string | null
          sold_on?: string | null
          sold_price?: number | null
          sold_to?: string | null
          status?: string
          transaction_line_id?: string | null
          updated_at?: string
          useful_life_months?: number | null
          vendor?: string | null
          warranty_notes?: string | null
          warranty_until?: string | null
        }
        Update: {
          archived?: boolean
          asset_no?: number
          category_id?: string | null
          code?: string
          condition?: string | null
          created_at?: string
          created_by?: string | null
          custom?: Json
          description?: string | null
          household_id?: string
          id?: string
          insurance_notes?: string | null
          insured?: boolean
          lent_on?: string | null
          lent_to?: string | null
          lifetime_warranty?: boolean
          location_id?: string | null
          manufacturer?: string | null
          model_no?: string | null
          name?: string
          parent_id?: string | null
          purchase_price?: number | null
          purchased_on?: string | null
          quantity?: number
          sale_transaction_id?: string | null
          salvage_value?: number | null
          serial_no?: string | null
          sold_on?: string | null
          sold_price?: number | null
          sold_to?: string | null
          status?: string
          transaction_line_id?: string | null
          updated_at?: string
          useful_life_months?: number | null
          vendor?: string | null
          warranty_notes?: string | null
          warranty_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_household_id_location_id_fkey"
            columns: ["household_id", "location_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "v_asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_sale_transaction_id_fkey"
            columns: ["household_id", "sale_transaction_id"]
            isOneToOne: false
            referencedRelation: "money_transaction"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "transaction_line"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "v_asset_pending_line"
            referencedColumns: ["household_id", "line_id"]
          },
          {
            foreignKeyName: "asset_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "v_line_route"
            referencedColumns: ["household_id", "line_id"]
          },
        ]
      }
      asset_tag: {
        Row: {
          asset_id: string
          household_id: string
          tag_id: string
        }
        Insert: {
          asset_id: string
          household_id: string
          tag_id: string
        }
        Update: {
          asset_id?: string
          household_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_tag_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_tag_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "v_asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_tag_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_tag_household_id_tag_id_fkey"
            columns: ["household_id", "tag_id"]
            isOneToOne: false
            referencedRelation: "tag"
            referencedColumns: ["household_id", "id"]
          },
        ]
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
          title: string | null
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
          title?: string | null
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
          title?: string | null
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
      category_field: {
        Row: {
          category_id: string
          created_at: string
          household_id: string
          id: string
          key: string
          label: string
          options: string[] | null
          sort: number
          type: string
        }
        Insert: {
          category_id: string
          created_at?: string
          household_id: string
          id?: string
          key: string
          label: string
          options?: string[] | null
          sort?: number
          type: string
        }
        Update: {
          category_id?: string
          created_at?: string
          household_id?: string
          id?: string
          key?: string
          label?: string
          options?: string[] | null
          sort?: number
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "category_field_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "category_field_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
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
      maintenance_log: {
        Row: {
          asset_id: string
          cost: number | null
          created_at: string
          created_by: string | null
          created_expense: boolean
          done_on: string
          household_id: string
          id: string
          notes: string | null
          plan_id: string | null
          title: string
          transaction_id: string | null
          updated_at: string
          usage_reading: number | null
          vendor: string | null
        }
        Insert: {
          asset_id: string
          cost?: number | null
          created_at?: string
          created_by?: string | null
          created_expense?: boolean
          done_on?: string
          household_id: string
          id?: string
          notes?: string | null
          plan_id?: string | null
          title: string
          transaction_id?: string | null
          updated_at?: string
          usage_reading?: number | null
          vendor?: string | null
        }
        Update: {
          asset_id?: string
          cost?: number | null
          created_at?: string
          created_by?: string | null
          created_expense?: boolean
          done_on?: string
          household_id?: string
          id?: string
          notes?: string | null
          plan_id?: string | null
          title?: string
          transaction_id?: string | null
          updated_at?: string
          usage_reading?: number | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_log_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_log_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "v_asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_log_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_log_household_id_plan_id_fkey"
            columns: ["household_id", "plan_id"]
            isOneToOne: false
            referencedRelation: "maintenance_plan"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_log_household_id_plan_id_fkey"
            columns: ["household_id", "plan_id"]
            isOneToOne: false
            referencedRelation: "v_maintenance_due"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_log_household_id_transaction_id_fkey"
            columns: ["household_id", "transaction_id"]
            isOneToOne: false
            referencedRelation: "money_transaction"
            referencedColumns: ["household_id", "id"]
          },
        ]
      }
      maintenance_plan: {
        Row: {
          active: boolean
          asset_id: string
          category_id: string | null
          created_at: string
          every_days: number | null
          every_usage: number | null
          household_id: string
          id: string
          name: string
          next_due: string | null
          notes: string | null
          notify_days_before: number
          updated_at: string
          usage_unit: string | null
        }
        Insert: {
          active?: boolean
          asset_id: string
          category_id?: string | null
          created_at?: string
          every_days?: number | null
          every_usage?: number | null
          household_id: string
          id?: string
          name: string
          next_due?: string | null
          notes?: string | null
          notify_days_before?: number
          updated_at?: string
          usage_unit?: string | null
        }
        Update: {
          active?: boolean
          asset_id?: string
          category_id?: string | null
          created_at?: string
          every_days?: number | null
          every_usage?: number | null
          household_id?: string
          id?: string
          name?: string
          next_due?: string | null
          notes?: string | null
          notify_days_before?: number
          updated_at?: string
          usage_unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_plan_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_plan_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "v_asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_plan_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_plan_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
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
      product: {
        Row: {
          archived: boolean
          attributes: Json
          category_id: string | null
          code: string
          created_at: string
          created_by: string | null
          default_due_days: number | null
          default_location_id: string | null
          due_days_after_open: number | null
          due_days_frozen: number | null
          due_type: string
          household_id: string
          id: string
          min_qty: number | null
          name: string
          name_si: string | null
          notes: string | null
          parent_id: string | null
          purchase_unit_id: string | null
          quick_consume_qty: number
          reorder_qty: number | null
          stock_unit_id: string
          treat_opened_as_out: boolean
          updated_at: string
        }
        Insert: {
          archived?: boolean
          attributes?: Json
          category_id?: string | null
          code: string
          created_at?: string
          created_by?: string | null
          default_due_days?: number | null
          default_location_id?: string | null
          due_days_after_open?: number | null
          due_days_frozen?: number | null
          due_type?: string
          household_id: string
          id?: string
          min_qty?: number | null
          name: string
          name_si?: string | null
          notes?: string | null
          parent_id?: string | null
          purchase_unit_id?: string | null
          quick_consume_qty?: number
          reorder_qty?: number | null
          stock_unit_id: string
          treat_opened_as_out?: boolean
          updated_at?: string
        }
        Update: {
          archived?: boolean
          attributes?: Json
          category_id?: string | null
          code?: string
          created_at?: string
          created_by?: string | null
          default_due_days?: number | null
          default_location_id?: string | null
          due_days_after_open?: number | null
          due_days_frozen?: number | null
          due_type?: string
          household_id?: string
          id?: string
          min_qty?: number | null
          name?: string
          name_si?: string | null
          notes?: string | null
          parent_id?: string | null
          purchase_unit_id?: string | null
          quick_consume_qty?: number
          reorder_qty?: number | null
          stock_unit_id?: string
          treat_opened_as_out?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_household_id_default_location_id_fkey"
            columns: ["household_id", "default_location_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "product_purchase_unit_id_fkey"
            columns: ["purchase_unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_stock_unit_id_fkey"
            columns: ["stock_unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
          },
        ]
      }
      product_alias: {
        Row: {
          alias_norm: string
          created_at: string
          destiny: string
          hits: number
          household_id: string
          id: string
          last_used_at: string
          merchant_id: string | null
          product_id: string | null
        }
        Insert: {
          alias_norm: string
          created_at?: string
          destiny: string
          hits?: number
          household_id: string
          id?: string
          last_used_at?: string
          merchant_id?: string | null
          product_id?: string | null
        }
        Update: {
          alias_norm?: string
          created_at?: string
          destiny?: string
          hits?: number
          household_id?: string
          id?: string
          last_used_at?: string
          merchant_id?: string | null
          product_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_alias_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_alias_household_id_merchant_id_fkey"
            columns: ["household_id", "merchant_id"]
            isOneToOne: false
            referencedRelation: "merchant"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_alias_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_alias_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
        ]
      }
      product_barcode: {
        Row: {
          barcode: string
          created_at: string
          household_id: string
          id: string
          merchant_id: string | null
          note: string | null
          product_id: string
          qty: number
          unit_id: string | null
        }
        Insert: {
          barcode: string
          created_at?: string
          household_id: string
          id?: string
          merchant_id?: string | null
          note?: string | null
          product_id: string
          qty?: number
          unit_id?: string | null
        }
        Update: {
          barcode?: string
          created_at?: string
          household_id?: string
          id?: string
          merchant_id?: string | null
          note?: string | null
          product_id?: string
          qty?: number
          unit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_barcode_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_barcode_household_id_merchant_id_fkey"
            columns: ["household_id", "merchant_id"]
            isOneToOne: false
            referencedRelation: "merchant"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_barcode_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_barcode_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "product_barcode_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
          },
        ]
      }
      product_unit_conversion: {
        Row: {
          created_at: string
          factor: number
          from_unit_id: string
          household_id: string
          product_id: string
          to_unit_id: string
        }
        Insert: {
          created_at?: string
          factor: number
          from_unit_id: string
          household_id: string
          product_id: string
          to_unit_id: string
        }
        Update: {
          created_at?: string
          factor?: number
          from_unit_id?: string
          household_id?: string
          product_id?: string
          to_unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_unit_conversion_from_unit_id_fkey"
            columns: ["from_unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_unit_conversion_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_unit_conversion_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "product_unit_conversion_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "product_unit_conversion_to_unit_id_fkey"
            columns: ["to_unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
          },
        ]
      }
      shopping_list_item: {
        Row: {
          created_at: string
          created_by: string | null
          dismissed: boolean
          done: boolean
          done_at: string | null
          done_by: string | null
          done_by_line: string | null
          free_text: string | null
          household_id: string
          id: string
          list: string
          note: string | null
          product_id: string | null
          qty: number | null
          source: string
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          dismissed?: boolean
          done?: boolean
          done_at?: string | null
          done_by?: string | null
          done_by_line?: string | null
          free_text?: string | null
          household_id: string
          id?: string
          list?: string
          note?: string | null
          product_id?: string | null
          qty?: number | null
          source?: string
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          dismissed?: boolean
          done?: boolean
          done_at?: string | null
          done_by?: string | null
          done_by_line?: string | null
          free_text?: string | null
          household_id?: string
          id?: string
          list?: string
          note?: string | null
          product_id?: string | null
          qty?: number | null
          source?: string
          unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shopping_list_item_household_id_done_by_line_fkey"
            columns: ["household_id", "done_by_line"]
            isOneToOne: false
            referencedRelation: "transaction_line"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_done_by_line_fkey"
            columns: ["household_id", "done_by_line"]
            isOneToOne: false
            referencedRelation: "v_asset_pending_line"
            referencedColumns: ["household_id", "line_id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_done_by_line_fkey"
            columns: ["household_id", "done_by_line"]
            isOneToOne: false
            referencedRelation: "v_line_route"
            referencedColumns: ["household_id", "line_id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "shopping_list_item_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
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
      stock_lot: {
        Row: {
          created_at: string
          created_by: string | null
          due_date: string | null
          household_id: string
          id: string
          location_id: string | null
          note: string | null
          opened_at: string | null
          product_id: string
          purchased_on: string | null
          qty_initial: number
          qty_remaining: number
          split_from_id: string | null
          status: string | null
          transaction_line_id: string | null
          unit_cost: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          household_id: string
          id?: string
          location_id?: string | null
          note?: string | null
          opened_at?: string | null
          product_id: string
          purchased_on?: string | null
          qty_initial: number
          qty_remaining?: number
          split_from_id?: string | null
          status?: string | null
          transaction_line_id?: string | null
          unit_cost?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          household_id?: string
          id?: string
          location_id?: string | null
          note?: string | null
          opened_at?: string | null
          product_id?: string
          purchased_on?: string | null
          qty_initial?: number
          qty_remaining?: number
          split_from_id?: string | null
          status?: string | null
          transaction_line_id?: string | null
          unit_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_lot_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_location_id_fkey"
            columns: ["household_id", "location_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_split_from_id_fkey"
            columns: ["household_id", "split_from_id"]
            isOneToOne: false
            referencedRelation: "stock_lot"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "transaction_line"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "v_asset_pending_line"
            referencedColumns: ["household_id", "line_id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "v_line_route"
            referencedColumns: ["household_id", "line_id"]
          },
        ]
      }
      stock_movement: {
        Row: {
          actor: string | null
          correlation_id: string
          created_at: string
          delta: number
          household_id: string
          id: string
          location_id: string | null
          lot_id: string
          meta: Json | null
          note: string | null
          product_id: string
          reason: string
          reverses_id: string | null
          seq: number
          unit_cost: number | null
        }
        Insert: {
          actor?: string | null
          correlation_id: string
          created_at?: string
          delta: number
          household_id: string
          id?: string
          location_id?: string | null
          lot_id: string
          meta?: Json | null
          note?: string | null
          product_id: string
          reason: string
          reverses_id?: string | null
          seq?: never
          unit_cost?: number | null
        }
        Update: {
          actor?: string | null
          correlation_id?: string
          created_at?: string
          delta?: number
          household_id?: string
          id?: string
          location_id?: string | null
          lot_id?: string
          meta?: Json | null
          note?: string | null
          product_id?: string
          reason?: string
          reverses_id?: string | null
          seq?: never
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movement_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_location_id_fkey"
            columns: ["household_id", "location_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_lot_id_fkey"
            columns: ["household_id", "lot_id"]
            isOneToOne: false
            referencedRelation: "stock_lot"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_reverses_id_fkey"
            columns: ["household_id", "reverses_id"]
            isOneToOne: false
            referencedRelation: "stock_movement"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_reverses_id_fkey"
            columns: ["household_id", "reverses_id"]
            isOneToOne: false
            referencedRelation: "v_stock_journal"
            referencedColumns: ["household_id", "id"]
          },
        ]
      }
      tag: {
        Row: {
          color: string | null
          created_at: string
          household_id: string
          id: string
          name: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          household_id: string
          id?: string
          name: string
        }
        Update: {
          color?: string | null
          created_at?: string
          household_id?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "tag_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
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
          product_id: string | null
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
          product_id?: string | null
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
          product_id?: string | null
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
            foreignKeyName: "transaction_line_product_fk"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "transaction_line_product_fk"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
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
      v_asset: {
        Row: {
          archived: boolean | null
          asset_no: number | null
          bill_date: string | null
          bill_id: string | null
          bill_payee: string | null
          book_value: number | null
          category_id: string | null
          category_name: string | null
          category_parent_id: string | null
          category_parent_name: string | null
          code: string | null
          condition: string | null
          cost_of_ownership: number | null
          cost_per_month: number | null
          created_at: string | null
          created_by: string | null
          current_value: number | null
          custom: Json | null
          description: string | null
          household_id: string | null
          id: string | null
          insurance_notes: string | null
          insured: boolean | null
          last_maintained_on: string | null
          lent_on: string | null
          lent_to: string | null
          lifetime_warranty: boolean | null
          location_id: string | null
          location_path: string | null
          maintenance_cost: number | null
          manufacturer: string | null
          model_no: string | null
          months_owned: number | null
          name: string | null
          next_due: string | null
          parent_asset_no: number | null
          parent_id: string | null
          parent_name: string | null
          parts: number | null
          purchase_price: number | null
          purchased_on: string | null
          quantity: number | null
          sale_gain: number | null
          sale_transaction_id: string | null
          salvage_value: number | null
          serial_no: string | null
          sold_on: string | null
          sold_price: number | null
          sold_to: string | null
          status: string | null
          tag: string | null
          tag_ids: string[] | null
          tag_names: string[] | null
          today: string | null
          transaction_line_id: string | null
          updated_at: string | null
          useful_life_months: number | null
          vendor: string | null
          warranty_days_left: number | null
          warranty_notes: string | null
          warranty_until: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_household_id_location_id_fkey"
            columns: ["household_id", "location_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_parent_id_fkey"
            columns: ["household_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "v_asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_sale_transaction_id_fkey"
            columns: ["household_id", "sale_transaction_id"]
            isOneToOne: false
            referencedRelation: "money_transaction"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "transaction_line"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "asset_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "v_asset_pending_line"
            referencedColumns: ["household_id", "line_id"]
          },
          {
            foreignKeyName: "asset_household_id_transaction_line_id_fkey"
            columns: ["household_id", "transaction_line_id"]
            isOneToOne: false
            referencedRelation: "v_line_route"
            referencedColumns: ["household_id", "line_id"]
          },
        ]
      }
      v_asset_pending_line: {
        Row: {
          account_id: string | null
          amount: number | null
          category_id: string | null
          category_name: string | null
          household_id: string | null
          line_id: string | null
          line_no: number | null
          occurred_at: string | null
          occurred_on: string | null
          payee_text: string | null
          qty: number | null
          raw_name: string | null
          source: string | null
          transaction_id: string | null
          unit_text: string | null
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
        ]
      }
      v_line_route: {
        Row: {
          destiny: string | null
          first_lot_id: string | null
          household_id: string | null
          line_id: string | null
          line_no: number | null
          lots: number | null
          product_id: string | null
          product_name: string | null
          qty_initial: number | null
          qty_remaining: number | null
          stock_unit_code: string | null
          transaction_id: string | null
        }
        Relationships: [
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
            foreignKeyName: "transaction_line_product_fk"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "transaction_line_product_fk"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
        ]
      }
      v_maintenance_due: {
        Row: {
          active: boolean | null
          asset_id: string | null
          asset_name: string | null
          asset_no: number | null
          asset_status: string | null
          category_id: string | null
          days_left: number | null
          every_days: number | null
          every_usage: number | null
          household_id: string | null
          id: string | null
          last_done_on: string | null
          name: string | null
          next_due: string | null
          notes: string | null
          notify_days_before: number | null
          usage_unit: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_plan_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_plan_household_id_asset_id_fkey"
            columns: ["household_id", "asset_id"]
            isOneToOne: false
            referencedRelation: "v_asset"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_plan_household_id_category_id_fkey"
            columns: ["household_id", "category_id"]
            isOneToOne: false
            referencedRelation: "category"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "maintenance_plan_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
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
      v_product_price: {
        Row: {
          household_id: string | null
          last_bought_on: string | null
          last_unit_cost: number | null
          merchant_id: string | null
          merchant_name: string | null
          min_unit_cost_180d: number | null
          product_id: string | null
          times: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_lot_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
        ]
      }
      v_product_stock: {
        Row: {
          below_min: boolean | null
          household_id: string | null
          last_unit_cost: number | null
          lots: number | null
          next_due: string | null
          product_id: string | null
          qty: number | null
          qty_effective: number | null
          qty_opened: number | null
          unpriced_qty: number | null
          value: number | null
        }
        Relationships: [
          {
            foreignKeyName: "product_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
        ]
      }
      v_shopping_list: {
        Row: {
          below_min: boolean | null
          best_bought_on: string | null
          best_merchant: string | null
          best_unit_cost: number | null
          bought_at: string | null
          bought_on: string | null
          bought_transaction_id: string | null
          created_at: string | null
          created_by: string | null
          dismissed: boolean | null
          done: boolean | null
          done_at: string | null
          done_by: string | null
          done_by_line: string | null
          free_text: string | null
          household_id: string | null
          id: string | null
          list: string | null
          min_qty: number | null
          note: string | null
          product_id: string | null
          product_name: string | null
          qty: number | null
          source: string | null
          stock_qty: number | null
          stock_unit_code: string | null
          stock_unit_id: string | null
          unit_code: string | null
          unit_id: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_stock_unit_id_fkey"
            columns: ["stock_unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_done_by_line_fkey"
            columns: ["household_id", "done_by_line"]
            isOneToOne: false
            referencedRelation: "transaction_line"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_done_by_line_fkey"
            columns: ["household_id", "done_by_line"]
            isOneToOne: false
            referencedRelation: "v_asset_pending_line"
            referencedColumns: ["household_id", "line_id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_done_by_line_fkey"
            columns: ["household_id", "done_by_line"]
            isOneToOne: false
            referencedRelation: "v_line_route"
            referencedColumns: ["household_id", "line_id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "shopping_list_item_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "shopping_list_item_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "unit"
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
      v_stock: {
        Row: {
          any_opened: boolean | null
          household_id: string | null
          location_id: string | null
          lots: number | null
          next_due: string | null
          product_id: string | null
          qty: number | null
          value: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_lot_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_location_id_fkey"
            columns: ["household_id", "location_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_lot_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
        ]
      }
      v_stock_journal: {
        Row: {
          actor: string | null
          actor_name: string | null
          correlation_id: string | null
          created_at: string | null
          delta: number | null
          household_id: string | null
          id: string | null
          location_id: string | null
          location_path: string | null
          lot_id: string | null
          meta: Json | null
          note: string | null
          product_id: string | null
          product_name: string | null
          reason: string | null
          reverses_id: string | null
          seq: number | null
          undone: boolean | null
          unit_code: string | null
          unit_cost: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_movement_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "household"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_location_id_fkey"
            columns: ["household_id", "location_id"]
            isOneToOne: false
            referencedRelation: "location"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_lot_id_fkey"
            columns: ["household_id", "lot_id"]
            isOneToOne: false
            referencedRelation: "stock_lot"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "product"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_product_id_fkey"
            columns: ["household_id", "product_id"]
            isOneToOne: false
            referencedRelation: "v_product_stock"
            referencedColumns: ["household_id", "product_id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_reverses_id_fkey"
            columns: ["household_id", "reverses_id"]
            isOneToOne: false
            referencedRelation: "stock_movement"
            referencedColumns: ["household_id", "id"]
          },
          {
            foreignKeyName: "stock_movement_household_id_reverses_id_fkey"
            columns: ["household_id", "reverses_id"]
            isOneToOne: false
            referencedRelation: "v_stock_journal"
            referencedColumns: ["household_id", "id"]
          },
        ]
      }
      v_storage_usage: {
        Row: {
          bytes: number | null
          entity_type: string | null
          files: number | null
          household_id: string | null
          kind: string | null
          provider: string | null
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
    }
    Functions: {
      accept_invites_for: {
        Args: { p_email: string; p_user_id: string }
        Returns: number
      }
      accept_pending_invites: { Args: never; Returns: number }
      rpc_asset_sell: { Args: { p: Json }; Returns: Json }
      rpc_asset_split: { Args: { p_asset: string }; Returns: string[] }
      rpc_asset_unsell: { Args: { p_asset: string }; Returns: undefined }
      rpc_consume: { Args: { p: Json }; Returns: Json }
      rpc_delete_maintenance_log: {
        Args: { p_delete_expense?: boolean; p_id: string }
        Returns: undefined
      }
      rpc_delete_transaction: {
        Args: { p_id: string; p_keep_stock?: boolean }
        Returns: undefined
      }
      rpc_import_bills: {
        Args: { p_bills: Json; p_household: string }
        Returns: Json
      }
      rpc_inventory: { Args: { p: Json }; Returns: Json }
      rpc_log_maintenance: { Args: { p: Json }; Returns: Json }
      rpc_move_transactions: {
        Args: { p_account: string; p_ids: string[] }
        Returns: number
      }
      rpc_open: { Args: { p: Json }; Returns: Json }
      rpc_purchase: { Args: { p: Json }; Returns: Json }
      rpc_route_lines: {
        Args: { p_routes: Json; p_tick?: Json; p_transaction: string }
        Returns: Json
      }
      rpc_save_transaction: { Args: { p: Json }; Returns: Json }
      rpc_set_lot_due: { Args: { p: Json }; Returns: Json }
      rpc_shopping_sync: { Args: { p_household: string }; Returns: Json }
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
      rpc_transfer: { Args: { p: Json }; Returns: Json }
      rpc_undo: { Args: { p_correlation: string }; Returns: Json }
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
