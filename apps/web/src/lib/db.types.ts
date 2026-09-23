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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invites_for: {
        Args: { p_email: string; p_user_id: string }
        Returns: number
      }
      accept_pending_invites: { Args: never; Returns: number }
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
